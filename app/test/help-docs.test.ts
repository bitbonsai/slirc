import "./fixture.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import { ANSWER_TIMEOUT_MS, CLASSIFIER_CONFIDENCE, OFFTOPIC_REPLY, SMALLTALK_REPLY, UNREACHABLE_REPLY, answerFromDocs, answerModel, askModel, classifierModel, modelCost, classifyQuestion, openRouterId, corpus, docsContext, docsUrl, docsVersion, loadDocs, plainRelativeLinks, readLabel, searchDocs, type ModelOptions, type ModelUsage } from "../src/help-docs.ts";

describe("docs corpus", () => {
  test("loads every guide with a title and a lead chunk", () => {
    const chunks = loadDocs();
    const docs = new Set(chunks.map((chunk) => chunk.doc));
    expect(docs.has("channels")).toBe(true);
    expect(docs.has("bots")).toBe(true);
    expect(docs.has("download")).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.title.length).toBeGreaterThan(0);
      expect(chunk.text).not.toContain("crumb:");
      expect(chunk.text).not.toContain("{{host}}");
    }
    const clientChunks = chunks.filter((chunk) => chunk.doc === "clients").map((chunk) => chunk.text).join("\n");
    const botChunks = chunks.filter((chunk) => chunk.doc === "bots").map((chunk) => chunk.text).join("\n");
    expect(clientChunks).toContain("app.example.test");
    expect(botChunks).toContain("app.example.test");
    expect(clientChunks).not.toContain("app.slirc.org");
    expect(botChunks).not.toContain("app.slirc.org");
  });

  test("answers point at the right guide", () => {
    const cases: [string, string][] = [
      ["how do invite links work?", "channels"],
      ["how do I turn notifications off on my phone?", "notifications"],
      ["what is a bot and how do I invite one?", "bots"],
      ["how do threads work", "threads"],
      ["can I pair a coding agent?", "agents"],
      ["how do I change my profile picture?", "getting-started"],
    ];
    for (const [question, doc] of cases) {
      expect(searchDocs(question)[0]?.doc, question).toBe(doc);
    }
  });

  test("says nothing when the docs say nothing", () => {
    expect(searchDocs("zzzz")).toEqual([]);
    expect(searchDocs("")).toEqual([]);
  });
});

describe("docs answers", () => {
  test("uses the model when one is configured", async () => {
    const seen: string[] = [];
    const ask = async (_question: string, context: string) => {
      seen.push(context);
      return "Invites add the person to the channel straight away.";
    };
    const answer = await answerFromDocs("how do invites work?", { ask });
    expect(answer.model).toBe(true);
    expect(answer.source).toBe(`${docsUrl()}/channels#invite-only-channels`);
    // The first call is the classifier, with no excerpts; the second is the answer.
    expect(seen[1]).toContain("## Channels & invites");
  });

  test("says the model is unreachable when it fails, and uses the docs excerpt when it is absent", async () => {
    const failing = async () => { throw new Error("help model returned 500"); };
    const failed = await answerFromDocs("how do invites work?", { ask: failing });
    expect(failed.model).toBe(false);
    expect(failed.text).toBe(UNREACHABLE_REPLY);
    expect(failed.source).toBe(`${docsUrl()}/channels#invite-only-channels`);

    process.env.OPENROUTER_API_KEY = "";
    const unconfigured = await answerFromDocs("how do invites work?");
    expect(unconfigured.model).toBe(false);
    expect(unconfigured.source).toBe(`${docsUrl()}/channels#invite-only-channels`);
  });

  test("skips the model when asked to", async () => {
    let called = false;
    const answer = await answerFromDocs("how do invites work?", { allowModel: false, ask: async () => { called = true; return "x"; } });
    expect(called).toBe(false);
    expect(answer.model).toBe(false);
  });

  test.each([
    ["chatter", "zzzz"],
    // "today" appears once in about.md, so this used to answer with that passage.
    ["a greeting that accidentally matches one word", "how are you today"],
    // `doing` and `today` land in different paragraphs of about.md.
    ["scattered one-word matches", "how are we doing today?"],
  ])("%s gets a reaction, not an answer", async (_name, question) => {
    const answer = await answerFromDocs(question, { allowModel: false });
    expect(answer.kind).toBe("react");
    expect(answer.text).toBe("");
    expect(answer.source).toBe("");
  });

  test("a question whose words share one passage still answers", async () => {
    const answer = await answerFromDocs("how do I upload a video?", { allowModel: false });
    expect(answer.kind).toBe("answer");
    expect(answer.source).toBe(`${docsUrl()}/messages#images-and-videos`);
  });

  test("strips a reasoning model's chain of thought from the answer", async () => {
    // MiniMax M3 returns its thinking inside content, closed or cut off by max_tokens.
    const answer = await answerFromDocs("how do invites work?", { ask: async () => "<think>The user asks about invites.\nInvites add people.</think>Invites add the person straight away." });
    expect(answer.kind).toBe("answer");
    expect(answer.text).toBe("Invites add the person straight away.");
    const react = await answerFromDocs("zzzz", { ask: async () => "<think>Chatter, no question here.</think>REACT" });
    expect(react.kind).toBe("react");
  });

  test("falls back to the excerpt when only reasoning came back", async () => {
    const answer = await answerFromDocs("how do invites work?", { ask: async () => "<think>cut off before the answer" });
    expect(answer.model).toBe(false);
    expect(answer.text.length).toBeGreaterThan(40);
    expect(answer.text).not.toContain("think");
  });

  test("admits when the docs do not cover a question", async () => {
    const answer = await answerFromDocs("can zzzz frobnicate?", { allowModel: false });
    expect(answer.kind).toBe("unknown");
    expect(answer.text).toContain("could not find that in the docs");
    // The client only linkifies absolute urls, and swallows trailing punctuation into the href.
    expect(answer.text).toContain(` ${docsUrl()} `);
    expect(answer.source).toBe("");
  });
});

test("help answers drop relative links and em dashes but keep absolute links", () => {
  const raw = "Pairing isn't available yet — view agents at [Open Agents](/?screen=agents). See [the guide](https://docs.slirc.org/agents).";
  expect(plainRelativeLinks(raw)).toBe("Pairing isn't available yet, view agents at Open Agents. See [the guide](https://docs.slirc.org/agents).");
});

// The beta help DM where the model said "I could not find that in the docs" to questions the docs cover.
describe("retrieval for real questions", () => {
  const sections = (question: string) => searchDocs(question, corpus(), 6).map((hit) => `${hit.doc} > ${hit.section || ""}`);
  const context = (question: string) => docsContext(searchDocs(question, corpus(), 6));

  test("what Slirc is", () => {
    expect(sections("what even is slirc")[0]).toBe("home > What is Slirc?");
    expect(context("what even is slirc")).toContain("Slirc is a self-hosted team chat.");
  });

  test("what it drops from Slack", () => {
    expect(sections("what is the extra weight from slack?")[0]).toBe("about > ");
    const text = context("what is the extra weight from slack?");
    expect(text).toContain("lose the weight");
    // The small About page goes in whole, so the paragraph that names the weight comes along.
    expect(text).toContain("a large Electron client");
  });

  test("private channels are the invite-only section", () => {
    const found = sections("okay - how can I start channels that are private?");
    expect(found.slice(0, 2)).toEqual(["channels > Invite-only channels", "channels > Creating a channel"]);
    const text = context("okay - how can I start channels that are private?");
    expect(text).toContain("## Channels & invites › Invite-only channels");
    expect(text).toContain("Verified members can create an invite-only channel");
    expect(text).toContain("It defaults to invite-only.");
  });

  test("people in the DM list", () => {
    expect(sections("I see people in my direct messages list - who are they?").slice(0, 2)).toEqual(["channels > Direct messages", "channels > Direct messages"]);
    const text = context("I see people in my direct messages list - who are they?");
    expect(text).toContain("## Channels & invites › Direct messages");
    expect(text).toContain("Other people appear through membership in a public or workspace channel");
  });

  test("context stays inside its budget", () => {
    for (const question of ["what even is slirc", "how do I set up slirc on my server with caddy and ergo?", "bots reminders help polls"]) {
      expect(docsContext(searchDocs(question, corpus(), 6)).length).toBeLessThanOrEqual(8_000);
    }
  });
});

describe("classifier", () => {
  test("reads each label and fails open on junk", () => {
    expect(readLabel("slirc")).toBe("slirc");
    expect(readLabel("Smalltalk.")).toBe("smalltalk");
    expect(readLabel("small talk")).toBe("smalltalk");
    expect(readLabel("OFFTOPIC")).toBe("offtopic");
    expect(readLabel("off-topic")).toBe("offtopic");
    expect(readLabel("<think>a greeting, so smalltalk or slirc?</think>smalltalk")).toBe("smalltalk");
    expect(readLabel("not smalltalk, it is slirc")).toBeNull();
    expect(readLabel("banana")).toBeNull();
    expect(readLabel("")).toBeNull();
    expect(readLabel(null)).toBeNull();
  });

  test("errors and junk count as a Slirc question", async () => {
    expect(await classifyQuestion("hi", "", async () => { throw new Error("help model returned 500"); })).toEqual({ label: "slirc", sure: false });
    expect(await classifyQuestion("hi", "", async () => "I think this is a greeting")).toEqual({ label: "slirc", sure: false });
    expect(await classifyQuestion("hi", "", async () => null)).toEqual({ label: "slirc", sure: false });
    expect(await classifyQuestion("hi", "", async () => "smalltalk")).toEqual({ label: "smalltalk", sure: true });
  });

  test("asks the flash model with a tiny budget", async () => {
    let seen: ModelOptions = {};
    await classifyQuestion("thanks!", "", async (_q, _c, _conv, options = {}) => { seen = options; return "smalltalk"; });
    expect(seen.model).toBe("xiaomi/mimo-v2.6-flash");
    expect(seen.maxTokens).toBeLessThanOrEqual(64);
    expect(seen.user).toContain("Message: thanks!");
  });
});

describe("routing", () => {
  const scripted = (label: string, answer = "Invite-only channels stay hidden until someone invites you.") => {
    const calls: { model?: string; context: string; maxTokens?: number }[] = [];
    const ask = async (_question: string, context: string, _conversation = "", options: ModelOptions = {}) => {
      calls.push({ model: options.model, context, maxTokens: options.maxTokens });
      return options.model === classifierModel() ? label : answer;
    };
    return { calls, ask };
  };

  test("offtopic and smalltalk get the fixed line, never the answer model's reply", async () => {
    const off = scripted("offtopic");
    const offAnswer = await answerFromDocs("write me a poem about cheese", { ask: off.ask });
    expect(offAnswer).toMatchObject({ kind: "offtopic", text: OFFTOPIC_REPLY, source: "", model: false });
    expect(off.calls[0].model).toBe("xiaomi/mimo-v2.6-flash");

    const small = scripted("smalltalk");
    const smallAnswer = await answerFromDocs("thanks!", { ask: small.ask });
    expect(smallAnswer).toMatchObject({ kind: "smalltalk", text: SMALLTALK_REPLY, source: "", model: false });
    expect(small.calls[0].model).toBe("xiaomi/mimo-v2.6-flash");
  });

  test("a Slirc question goes to the answer model with the section that answers it", async () => {
    const run = scripted("slirc");
    const answer = await answerFromDocs("okay - how can I start channels that are private?", { ask: run.ask });
    expect(run.calls.map((call) => call.model)).toEqual(["xiaomi/mimo-v2.6-flash", "anthropic/claude-haiku-5.5"]);
    expect(run.calls[1].maxTokens).toBe(600);
    expect(run.calls[1].context).toContain("Verified members can create an invite-only channel");
    expect(answer).toMatchObject({ kind: "answer", model: true, source: `${docsUrl()}/channels#invite-only-channels` });
  });

  test("a sure Slirc label reaches the model even when the words barely match", async () => {
    // "slirc" alone is too common to pass the keyword check, so this used to stop at the docs.
    const run = scripted("slirc", "Slirc is a self-hosted team chat built on IRC.");
    const answer = await answerFromDocs("slirc?", { ask: run.ask });
    expect(run.calls.length).toBe(2);
    expect(answer.kind).toBe("answer");
  });

  test("without a sure label the keyword check still guards the model", async () => {
    const run = scripted("no idea");
    const answer = await answerFromDocs("how are you today", { ask: run.ask });
    // The answer model starts in the race; its reply is dropped.
    expect(answer).toMatchObject({ kind: "react", text: "", model: false });
  });
});

describe("models and cache", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["HELP_MODEL", "HELP_ANSWER_MODEL", "HELP_CLASSIFIER_MODEL"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("HELP_MODEL feeds the other helpers, not the docs answers", () => {
    delete process.env.HELP_ANSWER_MODEL;
    delete process.env.HELP_CLASSIFIER_MODEL;
    process.env.HELP_MODEL = "mimo-v2.5";
    expect(answerModel()).toBe("anthropic/claude-haiku-5.5");
    expect(classifierModel()).toBe("xiaomi/mimo-v2.6-flash");
    process.env.HELP_ANSWER_MODEL = "claude-haiku-5-5";
    expect(answerModel()).toBe("anthropic/claude-haiku-5.5");
    process.env.HELP_ANSWER_MODEL = "answer-model";
    process.env.HELP_CLASSIFIER_MODEL = "sorting-model";
    expect(answerModel()).toBe("answer-model");
    expect(classifierModel()).toBe("sorting-model");
  });

  test("a model change or the version bump invalidates cached answers", async () => {
    delete process.env.HELP_ANSWER_MODEL;
    const current = docsVersion();
    process.env.HELP_ANSWER_MODEL = "mimo-v2.5";
    expect(docsVersion()).not.toBe(current);
    delete process.env.HELP_ANSWER_MODEL;
    // An old "could not find" answer under another version is never served.
    db.query("INSERT INTO help_answer_cache (question, docs_version, kind, text, source, expires_at) VALUES (?, ?, 'unknown', 'I could not find that in the docs.', '', ?)")
      .run("when do email invitations expire?", "stale-version", Date.now() + 60_000);
    process.env.OPENROUTER_API_KEY = "";
    const answer = await answerFromDocs("when do email invitations expire?");
    expect(answer.cached).toBeUndefined();
    expect(answer.kind).toBe("answer");
    expect(answer.text).not.toContain("could not find");
  });

  test("an unknown answer is cached for minutes, not a day", async () => {
    process.env.OPENROUTER_API_KEY = "";
    const answer = await answerFromDocs("can zzzz frobnicate?");
    expect(answer.kind).toBe("unknown");
    const row = db.query("SELECT expires_at FROM help_answer_cache WHERE question = ? AND docs_version = ?").get("can zzzz frobnicate?", docsVersion()) as { expires_at: number };
    expect(row.expires_at).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  });
});

describe("Jev classifier", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.HELP_CLASSIFIER_MODEL;
  });

  const jev = (choice: string, confidence: number, status = 200) => {
    const requests: { url: string; body: any; auth: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { intent: { type: "choice", choice, confidence } }, usage: { input_tokens: 120, output_tokens: 1 } }), { status });
    }) as unknown as typeof fetch;
    return requests;
  };
  const noChat = async () => { throw new Error("the chat classifier should not run"); };

  test("sends the intent question to TypeSafe with the key", async () => {
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    const requests = jev("slirc", 0.98);
    expect(await classifyQuestion("how can I start channels that are private?", "", noChat)).toEqual({ label: "slirc", sure: true });
    expect(requests[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(requests[0].auth).toBe("Bearer test-typesafe-key");
    expect(requests[0].body.model).toBe("jev-latest");
    expect(requests[0].body.state).toBe("how can I start channels that are private?");
    expect(Object.keys(requests[0].body.questions.intent.criteria)).toEqual(["slirc", "smalltalk", "offtopic"]);
  });

  test("each label, and the confidence rule", async () => {
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    jev("smalltalk", 1);
    expect(await classifyQuestion("thanks!", "", noChat)).toEqual({ label: "smalltalk", sure: true });
    jev("offtopic", 1);
    expect(await classifyQuestion("write me a poem about cats", "", noChat)).toEqual({ label: "offtopic", sure: true });
    // A low-confidence Slirc label still answers; a low-confidence brush-off does not happen.
    jev("slirc", 0.28);
    expect(await classifyQuestion("what is the extra weight from slack?", "", noChat)).toEqual({ label: "slirc", sure: false });
    jev("offtopic", CLASSIFIER_CONFIDENCE - 0.01);
    expect(await classifyQuestion("hmm", "", noChat)).toEqual({ label: "slirc", sure: false });
    jev("banana", 1);
    expect(await classifyQuestion("hmm", "", noChat)).toEqual({ label: "slirc", sure: false });
  });

  test("errors and bad statuses answer as Slirc", async () => {
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    jev("offtopic", 1, 500);
    expect(await classifyQuestion("hmm", "", noChat)).toEqual({ label: "slirc", sure: false });
    globalThis.fetch = (async () => { throw new Error("The operation timed out."); }) as unknown as typeof fetch;
    expect(await classifyQuestion("hmm", "", noChat)).toEqual({ label: "slirc", sure: false });
  });

  test("routes off-topic without the answer model and records the call", async () => {
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    jev("offtopic", 1);
    db.query("DELETE FROM help_usage WHERE question = ?").run("write me a poem about cats");
    const models: (string | undefined)[] = [];
    const answer = await answerFromDocs("write me a poem about cats", { ask: async (_q, _c, _conv, options = {}) => { models.push(options.model); return "x"; } });
    expect(answer.kind).toBe("offtopic");
    // The answer model starts in the race and is dropped once Jev says off-topic.
    expect(models).toEqual(["anthropic/claude-haiku-5.5"]);
    const rows = db.query("SELECT model, input_tokens, cost_usd FROM help_usage WHERE question = ? ORDER BY id DESC").all("write me a poem about cats") as { model: string; input_tokens: number; cost_usd: number }[];
    expect(rows).toEqual([{ model: "jev-latest", input_tokens: 120, cost_usd: 120 * 42 / 1_000_000_000 }]);
  });

  test("falls back to the flash chat model without a TypeSafe key", async () => {
    globalThis.fetch = (async () => { throw new Error("TypeSafe should not be called"); }) as unknown as typeof fetch;
    let model: string | undefined;
    const result = await classifyQuestion("thanks!", "", async (_q, _c, _conv, options = {}) => { model = options.model; return "smalltalk"; });
    expect(result).toEqual({ label: "smalltalk", sure: true });
    expect(model).toBe("xiaomi/mimo-v2.6-flash");
    expect(classifierModel()).toBe("xiaomi/mimo-v2.6-flash");
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    expect(classifierModel()).toBe("jev-latest");
  });
});

test("help cost uses each model's list price, cached input and env overrides", () => {
  delete process.env.HELP_INPUT_PRICE_PER_MILLION;
  delete process.env.HELP_OUTPUT_PRICE_PER_MILLION;
  expect(modelCost("xiaomi/mimo-v2.6-pro", 1_000_000, 1_000_000)).toBeCloseTo(0.435 + 0.87, 6);
  expect(modelCost("xiaomi/mimo-v2.5", 1_000_000, 1_000_000)).toBeCloseTo(0.14 + 0.28, 6);
  expect(modelCost("xiaomi/mimo-v2.6-pro", 1_000_000, 0, 400_000)).toBeCloseTo(0.6 * 0.435 + 0.4 * 0.0036, 6);
  expect(modelCost("unknown-model", 1_000_000, 0)).toBeCloseTo(0.14, 6);
  expect(modelCost("anthropic/claude-haiku-5.5", 1_000_000, 1_000_000, 500_000)).toBeCloseTo(0.5 * 0.10 + 0.5 * 0.01 + 0.50, 6);
  process.env.HELP_INPUT_PRICE_PER_MILLION = "1";
  try { expect(modelCost("xiaomi/mimo-v2.6-pro", 1_000_000, 0)).toBeCloseTo(1, 6); }
  finally { delete process.env.HELP_INPUT_PRICE_PER_MILLION; }
});

describe("askModel on OpenRouter", () => {
  const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ["OPENROUTER_API_KEY", "APP_ORIGIN", "HELP_MODEL", "HELP_INPUT_PRICE_PER_MILLION", "HELP_OUTPUT_PRICE_PER_MILLION"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const gateway = (reply: unknown) => {
    const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    for (const key of ["APP_ORIGIN", "HELP_MODEL", "HELP_INPUT_PRICE_PER_MILLION", "HELP_OUTPUT_PRICE_PER_MILLION"]) delete process.env[key];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    return requests;
  };

  test("answers go to chat completions with the key, the app name and a cost request", async () => {
    const requests = gateway({ choices: [{ message: { content: "Invite-only channels stay hidden." } }], usage: { prompt_tokens: 1_000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 } } });
    process.env.APP_ORIGIN = "https://app.slirc.org";
    const answer = await answerFromDocs("how do private channels work?", { conversation: "earlier" });
    expect(requests.map((request) => request.url)).toEqual([OPENROUTER, OPENROUTER]);
    expect(requests.map((request) => request.body.model).sort()).toEqual(["anthropic/claude-haiku-5.5", "xiaomi/mimo-v2.6-flash"]);
    const call = requests.find((request) => request.body.model === "anthropic/claude-haiku-5.5")!;
    expect(call.headers).toEqual({ Authorization: "Bearer test-openrouter-key", "Content-Type": "application/json", "X-Title": "Slirc", "HTTP-Referer": "https://app.slirc.org" });
    expect(call.body.max_tokens).toBe(600);
    expect(call.body.temperature).toBe(0.2);
    expect(call.body.usage).toEqual({ include: true });
    expect(call.body.messages[0].role).toBe("system");
    expect(call.body.messages[0].content).toContain("You answer questions about Slirc");
    expect(call.body.messages[1].content).toContain("Question: how do private channels work?");
    // No cost in the response, so the price table prices it.
    expect(answer).toMatchObject({ kind: "answer", text: "Invite-only channels stay hidden.", model: true, inputTokens: 1_000, outputTokens: 300 });
    expect(answer.costUsd).toBeCloseTo((600 * 0.10 + 400 * 0.01 + 300 * 0.50) / 1_000_000, 12);
  });

  test("the cost OpenRouter reports wins over the price table", async () => {
    const requests = gateway({ choices: [{ message: { content: "smalltalk" } }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 40 }, cost: 0.000123 } });
    let used: ModelUsage | null = null;
    const reply = await askModel("thanks!", "", "", { model: "xiaomi/mimo-v2.6-flash", system: "Sort it.", user: "Message: thanks!", maxTokens: 64, onUsage: (usage) => { used = usage; } });
    expect(reply).toBe("smalltalk");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["HTTP-Referer"]).toBeUndefined();
    expect(requests[0].body).toEqual({ model: "xiaomi/mimo-v2.6-flash", messages: [{ role: "system", content: "Sort it." }, { role: "user", content: "Message: thanks!" }], max_tokens: 64, temperature: 0.2, usage: { include: true } });
    expect(used!).toEqual({ input: 100, output: 2, cost: 0.000123 });
  });

  test("bare ids from older env files reach OpenRouter as vendor ids", async () => {
    const requests = gateway({ choices: [{ message: { content: "ok" } }] });
    await askModel("q", "c");
    process.env.HELP_MODEL = "mimo-v2.5";
    await askModel("q", "c");
    await askModel("q", "c", "", { model: "claude-haiku-5-5" });
    expect(requests.map((request) => request.body.model)).toEqual(["xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5", "anthropic/claude-haiku-5.5"]);
    expect(openRouterId("qwen3.8-flash")).toBe("qwen/qwen3.8-flash");
    expect(openRouterId("minimax-m3")).toBe("minimax/minimax-m3");
    expect(openRouterId("moonshotai/kimi-k3")).toBe("moonshotai/kimi-k3");
    expect(openRouterId("jev-latest")).toBe("jev-latest");
  });

  test("without a key nothing is sent", async () => {
    const requests = gateway({});
    delete process.env.OPENROUTER_API_KEY;
    expect(await askModel("q", "c")).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test("a bad status throws", async () => {
    gateway({});
    globalThis.fetch = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await expect(askModel("q", "c")).rejects.toThrow("help model returned 502");
  });

  test("an abort stops the request in flight", async () => {
    gateway({});
    globalThis.fetch = (async (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const abort = new AbortController();
    const pending = askModel("q", "c", "", { model: "anthropic/claude-haiku-5.5", signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow();
  });
});

test("onAnswering fires only when a question goes to the answer model", async () => {
  let calls = 0;
  const ask = async () => "Choose + beside Channels.";
  await answerFromDocs("thanks!", { ask: async (_q, _c, _v, options) => options?.model === answerModel() ? ask() : "smalltalk", onAnswering: () => calls++ });
  expect(calls).toBe(0);
  await answerFromDocs("how do I make a private channel?", { ask: async (_q, _c, _v, options) => options?.model === answerModel() ? ask() : "slirc", onAnswering: () => calls++ });
  expect(calls).toBe(1);
});

describe("classifier race", () => {
  const WAIT = 100;
  const REPLY = "Choose + beside Channels and tick Invite only.";
  // A classifier and an answer model that each reply after their own delay. The answer honours the abort.
  const race = (label: string | Error, labelMs: number, answerMs: number) => {
    const state = { aborted: false, answered: false, typingAt: -1, started: performance.now() };
    const ask = async (_q: string, _c: string, _conv = "", options: ModelOptions = {}) => {
      if (options.model === classifierModel()) {
        await Bun.sleep(labelMs);
        if (label instanceof Error) throw label;
        options.onUsage?.({ input: 50, output: 1, cost: 0.00001 });
        return label;
      }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.answered = true;
          options.onUsage?.({ input: 900, output: 80, cost: 0.0002 });
          resolve(REPLY);
        }, answerMs);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); state.aborted = true; reject(new Error("aborted")); });
      });
    };
    const onAnswering = () => { state.typingAt = performance.now() - state.started; };
    const run = async (question: string) => {
      db.query("DELETE FROM help_usage WHERE question = ?").run(question.toLowerCase());
      state.started = performance.now();
      const answer = await answerFromDocs(question, { ask, onAnswering, classifierWait: WAIT });
      return { answer, elapsed: performance.now() - state.started };
    };
    return { state, run };
  };
  const usage = (question: string) => db.query("SELECT model, input_tokens FROM help_usage WHERE question = ? ORDER BY id").all(question);

  test("a fast off-topic label aborts the answer and never shows typing", async () => {
    const { state, run } = race("offtopic", 20, 300);
    const { answer, elapsed } = await run("how do I make a private channel?");
    expect(answer).toMatchObject({ kind: "offtopic", text: OFFTOPIC_REPLY });
    expect(state).toMatchObject({ aborted: true, answered: false, typingAt: -1 });
    expect(elapsed).toBeLessThan(WAIT);
    expect(usage("how do i make a private channel?")).toEqual([{ model: "xiaomi/mimo-v2.6-flash", input_tokens: 50 }]);
  });

  test("a slow classifier is ignored after the window and the answer goes out", async () => {
    const { state, run } = race("offtopic", 400, 150);
    const { answer, elapsed } = await run("how do I start an invite-only channel?");
    expect(answer).toMatchObject({ kind: "answer", text: REPLY, model: true, inputTokens: 900 });
    // Typing starts when the window closes, the reply lands at the answer model's own pace, and
    // neither waits for the 400ms label.
    expect(state.typingAt).toBeGreaterThanOrEqual(WAIT - 5);
    expect(state.typingAt).toBeLessThan(elapsed);
    expect(elapsed).toBeGreaterThanOrEqual(145);
    expect(elapsed).toBeLessThan(400);
    expect(usage("how do i start an invite-only channel?")).toEqual([{ model: "anthropic/claude-haiku-5.5", input_tokens: 900 }]);
    // The late label still logs what it cost.
    await Bun.sleep(300);
    expect(usage("how do i start an invite-only channel?")).toEqual([{ model: "anthropic/claude-haiku-5.5", input_tokens: 900 }, { model: "xiaomi/mimo-v2.6-flash", input_tokens: 50 }]);
  });

  test("a classifier error answers", async () => {
    const { state, run } = race(new Error("help model returned 500"), 10, 30);
    const { answer, elapsed } = await run("how do I create private channels?");
    expect(answer).toMatchObject({ kind: "answer", text: REPLY, model: true });
    // Neither typing nor the reply waits for the window to close.
    expect(state.typingAt).toBeLessThan(WAIT);
    expect(elapsed).toBeLessThan(WAIT);
    expect(usage("how do i create private channels?")).toEqual([{ model: "anthropic/claude-haiku-5.5", input_tokens: 900 }]);
  });

  test("an answer that beats an off-topic label inside the window is not sent", async () => {
    const { state, run } = race("offtopic", 30, 10);
    const { answer, elapsed } = await run("how do I make an invite-only channel?");
    expect(answer).toMatchObject({ kind: "offtopic", text: OFFTOPIC_REPLY });
    expect(state).toMatchObject({ answered: true, typingAt: -1 });
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(WAIT);
    expect(usage("how do i make an invite-only channel?")).toEqual([{ model: "xiaomi/mimo-v2.6-flash", input_tokens: 50 }]);
  });

  test("a fast Slirc label answers in parallel, not after the classifier", async () => {
    const { state, run } = race("slirc", 60, 80);
    const { answer, elapsed } = await run("how do I make private channels?");
    expect(answer).toMatchObject({ kind: "answer", text: REPLY, model: true });
    expect(state.typingAt).toBeGreaterThanOrEqual(55);
    expect(state.typingAt).toBeLessThan(elapsed);
    // One after the other would take at least 60 + 80ms.
    expect(elapsed).toBeLessThan(60 + 80);
    expect(usage("how do i make private channels?")).toEqual([{ model: "xiaomi/mimo-v2.6-flash", input_tokens: 50 }, { model: "anthropic/claude-haiku-5.5", input_tokens: 900 }]);
  });
});

test("a timed-out answer call says the model is unreachable and is not cached", async () => {
  let answerCalls = 0;
  let timeout = 0;
  const ask: typeof askModel = async (_q, _c, _v, options) => {
    if (options?.model !== answerModel()) return "slirc";
    answerCalls++;
    timeout = options.timeoutMs ?? 0;
    throw new Error("The operation timed out.");
  };
  const first = await answerFromDocs("how do I make a private channel?", { ask });
  expect(first.text).toBe(UNREACHABLE_REPLY);
  expect(first.source).toContain("/channels");
  expect(timeout).toBe(ANSWER_TIMEOUT_MS);
  await answerFromDocs("how do I make a private channel?", { ask });
  expect(answerCalls).toBe(2);
});

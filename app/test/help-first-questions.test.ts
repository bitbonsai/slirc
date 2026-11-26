// The questions a new member or a tester sends help first, and what each one gets without a model.
// Fixed replies cost nothing; real questions cite the guide section they came from.
import "./fixture.ts";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

process.env.APP_ORIGIN = "https://ai-guild.slirc.app";
const { NUDGE_REPLY, SMALLTALK_REPLY, answerFromDocs, answerModel, corpus, docUrl, docsUrl, fixedReply, modelReply, sectionAnchor, selfReply, sourceLabel } = await import("../src/help-docs.ts");

const offline = (question: string, conversation = "") => answerFromDocs(question, { allowModel: false, conversation });
const DOCS = docsUrl();

test("greetings, questions about help, first steps and vague follow-ups get fixed replies", async () => {
  const self = selfReply();
  const fixed: [string, string, string][] = [
    ["hi", "smalltalk", SMALLTALK_REPLY],
    ["Hey there!", "smalltalk", SMALLTALK_REPLY],
    ["help", "answer", self],
    ["who are you?", "answer", self],
    ["what are you", "answer", self],
    ["hey, what can you do?", "answer", self],
    ["what can you tell me about yourself", "answer", self],
    ["Tell me about yourself.", "answer", self],
    ["what can I do here?", "answer", "Your first steps and a few things worth trying are at https://ai-guild.slirc.app/welcome. Ask me anything about Slirc too."],
    ["where do I start?", "answer", "Your first steps and a few things worth trying are at https://ai-guild.slirc.app/welcome. Ask me anything about Slirc too."],
    ["and now?", "answer", NUDGE_REPLY],
    ["now what?", "answer", NUDGE_REPLY],
    ["so?", "answer", NUDGE_REPLY],
  ];
  for (const [question, kind, text] of fixed) {
    const answer = await offline(question);
    expect({ question, kind: answer.kind, text: answer.text, source: answer.source, model: answer.model }).toEqual({ question, kind, text, source: "", model: false });
  }
  // A longer real question is not swallowed by a fixed reply.
  expect(fixedReply("who are you and how do I invite someone?")).toBeNull();
  expect(fixedReply("and now how do I add my phone?")).toBeNull();
});

test("first real questions answer from the guide section they came from", async () => {
  const cases: [string, string][] = [
    ["can I use agents?", `${DOCS}/agents#which-agents-work-today`],
    ["which agents work with Slirc?", `${DOCS}/agents#which-agents-work-today`],
    ["how do I add my phone?", `${DOCS}/getting-started#add-your-phone`],
    ["how do I install the app?", `${DOCS}/download`],
    ["how do I invite someone?", `${DOCS}/channels#inviting-people`],
    ["how do I make a private channel?", `${DOCS}/channels#invite-only-channels`],
    ["how do I turn on notifications?", `${DOCS}/notifications#turning-them-on`],
    ["how do reminders work?", `${DOCS}/bots#reminders-help-and-polls-remind-help-poll`],
  ];
  for (const [question, source] of cases) {
    const answer = await offline(question);
    expect({ question, kind: answer.kind, source: answer.source }).toEqual({ question, kind: "answer", source });
    expect(answer.text.length).toBeGreaterThan(20);
  }
});

test("agent questions say Pi, Claude Code, Codex and OpenCode work today and cite the agents guide", async () => {
  for (const question of ["can I use agents?", "which agents work with Slirc?"]) {
    const answer = await offline(question);
    expect(answer.source).toBe(`${DOCS}/agents#which-agents-work-today`);
    expect(answer.text).toStartWith("Pi, Claude Code, Codex and OpenCode work with Slirc today.");
    expect(answer.text).not.toMatch(/aren't available|not available|coming next/i);
  }
});

test("a follow-up after help's own replies still cites the guide, not the overview page", async () => {
  const conversation = [
    "Person: what can you tell me about yourself", `Help: ${selfReply()}`,
    "", "Person: and now?", `Help: I could not find that in the docs. ${DOCS} has the guides.`,
  ].join("\n");
  const answer = await offline("can I use agents?", conversation);
  expect(answer.source).toBe(`${DOCS}/agents#which-agents-work-today`);
});

test("every section anchor help can cite exists in the generated docs page", () => {
  const publicDocs = join(import.meta.dir, "..", "public", "docs");
  const pages = new Map<string, string>();
  for (const chunk of corpus()) {
    if (!chunk.section) continue;
    const file = chunk.doc === "home" ? join(publicDocs, "index.html") : join(publicDocs, chunk.doc, "index.html");
    if (!existsSync(file)) continue;
    if (!pages.has(file)) pages.set(file, readFileSync(file, "utf8"));
    expect(pages.get(file), `${chunk.doc} › ${chunk.section}`).toContain(`id="${sectionAnchor(chunk.section)}"`);
  }
  expect(pages.size).toBeGreaterThan(10);
});

test("links read as the docs host and guide, and the overview has no section", () => {
  expect(DOCS).toBe("https://ai-guild.slirc.app/docs");
  expect(docUrl("agents", "Connect a session")).toBe(`${DOCS}/agents#connect-a-session`);
  expect(docUrl("home")).toBe(`${DOCS}/`);
  expect(sourceLabel(`${DOCS}/agents#connect-a-session`)).toBe("ai-guild.slirc.app/docs/agents");
  expect(sourceLabel(`${DOCS}/`)).toBe("ai-guild.slirc.app/docs");
});

test("model questions name this instance's answer model and OpenRouter, or say there is none", async () => {
  const saved = { key: process.env.OPENROUTER_API_KEY, model: process.env.HELP_ANSWER_MODEL };
  try {
    process.env.OPENROUTER_API_KEY = "test-only";
    process.env.HELP_ANSWER_MODEL = "xiaomi/mimo-v2.6-pro";
    for (const question of ["Which model are you using?", "what model are you?", "what LLM is this?", "are you GPT?", "are you Claude or GPT?", "what AI is this", "what's the model behind you?", "do you use ChatGPT?", "which llm powers help"]) {
      const answer = await offline(question);
      expect({ question, kind: answer.kind, model: answer.model, text: answer.text }).toEqual({ question, kind: "answer", model: false, text: modelReply() });
    }
    expect(modelReply()).toBe("I answer with MiMo V2.6 Pro through OpenRouter. I only read the Slirc guides.");
    delete process.env.HELP_ANSWER_MODEL;
    expect(answerModel()).toBe("anthropic/claude-haiku-5.5");
    expect(modelReply()).toBe("I answer with Claude Haiku 5.5 through OpenRouter. I only read the Slirc guides.");
    delete process.env.OPENROUTER_API_KEY;
    expect(modelReply()).toBe("I answer by matching words in the Slirc guides, without a model. I only read the Slirc guides.");
    // A device question is a Slirc question, not a model question.
    expect(fixedReply("what model of iPhone gets notifications?")).toBeNull();
    expect(fixedReply("can I use agents?")).toBeNull();
    expect(fixedReply("can I use an AI agent here?")).toBeNull();
    expect(fixedReply("does Slirc work with Claude Code?")).toBeNull();
    expect(fixedReply("can I connect Claude Code as an agent and talk to it from my phone?")).toBeNull();
  } finally {
    if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.HELP_ANSWER_MODEL; else process.env.HELP_ANSWER_MODEL = saved.model;
  }
});

test("help says it is read-only, in its own reply and in the model reply", () => {
  expect(selfReply()).toContain("I only read those guides and the conversations I'm in, and I can't change settings or act for you.");
  expect(modelReply()).toEndWith("I only read the Slirc guides.");
  // Short, fixed, no link and no talk about settings or operators.
  expect(modelReply()).not.toMatch(/https?:|server|admin|setting|classif/i);
});

test("what help can do and what Slirc can do land differently", async () => {
  const self = await offline("what can you do?");
  expect(self).toMatchObject({ kind: "answer", text: selfReply(), source: "" });
  for (const question of ["what can Slirc do?", "what is Slirc?", "what is this app?", "What's Slirc for?"]) {
    const product = await offline(question);
    expect({ question, kind: product.kind, source: product.source }).toEqual({ question, kind: "answer", source: `${DOCS}/about` });
    expect(product.text).not.toBe(selfReply());
  }
});

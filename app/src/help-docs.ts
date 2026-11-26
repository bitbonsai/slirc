import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { db } from "./db.ts";
import { configuredAppOrigin } from "./request-security.ts";

export type Chunk = { doc: string; title: string; path: string; text: string; section?: string; lead?: boolean };
export type Hit = Chunk & { score: number };
export type Answer = { kind: "answer" | "react" | "unknown" | "smalltalk" | "offtopic"; text: string; source: string; model: boolean; inputTokens?: number; outputTokens?: number; costUsd?: number; cached?: boolean };
export type Label = "slirc" | "smalltalk" | "offtopic";

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "do", "does", "how", "what", "where", "when", "why", "who", "can", "i", "my", "me", "it", "for", "on", "with", "that", "this", "be", "you", "your", "we", "us", "they", "them", "their", "at", "as", "if", "from", "not", "no", "but", "so", "just", "even", "okay", "ok", "there", "about", "work", "works", "today", "use", "uses", "using", "get", "gets", "want", "like", "need", "know", "see", "look", "thing", "things", "way"]);

// People ask in their words, the guides answer in theirs. Both sides fold to one word, so
// "start a private channel" finds "Creating a channel" and the invite-only section.
const PHRASES: [RegExp, string][] = [
  [/\b(direct[ -]messag(e|es|ing)|private messages?|pms?|dms?)\b/g, " dm "],
  [/\binvite[ -]only\b/g, " invite private "],
  // "Install the app" is saving it to the Home Screen; "turn on" is not the same as "turn off".
  [/\bhome ?screen\b/g, " homescreen install "],
  [/\bturn(s|ed|ing)?( \w+)? on\b/g, " enable "],
  [/\bturn(s|ed|ing)?( \w+)? off\b/g, " disable "],
];
const SYNONYMS: Record<string, string> = Object.fromEntries([
  ...["start", "starts", "started", "starting", "make", "makes", "making", "creates", "created", "creating", "creation"].map((word) => [word, "create"]),
  ...["secret", "secrets"].map((word) => [word, "private"]),
  ...["person", "contact", "contacts", "user", "users", "someone"].map((word) => [word, "people"]),
]);

// Each instance serves its own guides at /docs.
export function docsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL("/docs", configuredAppOrigin(env)).href;
}

export function instanceHost(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(configuredAppOrigin(env)).hostname;
}
export const ANSWER_CACHE_VERSION = "8";

// Answers come from Claude Haiku; a classifier sorts the message first: TypeSafe's Jev when its key
// is set, a flash chat model otherwise. HELP_MODEL stays the default for the other helpers
// (reminders, welcome) and no longer picks the docs answer model. Every chat model goes through OpenRouter.
export const answerModel = () => openRouterId(process.env.HELP_ANSWER_MODEL || "anthropic/claude-haiku-5.5");
export const classifierModel = () => openRouterId(process.env.HELP_CLASSIFIER_MODEL || (process.env.TYPESAFE_API_KEY ? "jev-latest" : "xiaomi/mimo-v2.6-flash"));

// Small talk and off-topic replies replace the model's answer only when Jev is this sure. A Slirc label
// always answers, however unsure.
export const CLASSIFIER_CONFIDENCE = 0.6;
// The classifier races the answer model and gets this long to brush a message off; after that the
// answer goes out. Jev's own timeout is the same, since a later label would be ignored anyway.
export const CLASSIFIER_WAIT_MS = 1_500;
const JEV_CRITERIA: Record<Label, string> = {
  slirc: "A question about using, setting up or understanding Slirc, its features, privacy, hosting, or how it compares with Slack or IRC",
  smalltalk: "Greetings, thanks, acknowledgements or chit-chat with no question",
  offtopic: "Requests unrelated to Slirc, or nonsense",
};
const jevInputPrice = () => Number(process.env.TYPESAFE_INPUT_PRICE_PER_BILLION || "42");

// Haiku answers in 2 to 3.5s; past this the gateway is stuck, and an honest line beats a long wait.
export const ANSWER_TIMEOUT_MS = 5_000;
export const UNREACHABLE_REPLY = "I can't reach my answer model right now. The guide below should cover it, or try me again in a minute.";
export const OFFTOPIC_REPLY = "I only know Slirc. Try asking how to make a private channel or invite someone.";
export const SMALLTALK_REPLY = "Happy to help. Ask me anything about Slirc.";
// True in the code: help reads its DMs and the channels it was added to, and only posts replies and reactions.
const READ_ONLY = "I only read those guides and the conversations I'm in, and I can't change settings or act for you.";
export function selfReply(): string {
  return `I'm help, a bot that answers questions about Slirc from its guides at ${docsUrl()}. ${READ_ONLY} Try "how do I invite someone?" or "how do reminders work?"`;
}
// "anthropic/claude-haiku-5.5" reads as "Claude Haiku 5.5".
const MODEL_WORDS: Record<string, string> = { mimo: "MiMo", gpt: "GPT", qwen: "Qwen", minimax: "MiniMax", jev: "Jev" };
export function plainModelName(id: string): string {
  return (id.split("/").pop() || id).split("-").filter(Boolean)
    .map((word) => MODEL_WORDS[word] || word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
// The server knows the model it answers with, so the reply states it. Without a key there is none.
export function modelReply(): string {
  return process.env.OPENROUTER_API_KEY
    ? `I answer with ${plainModelName(answerModel())} through OpenRouter. I only read the Slirc guides.`
    : "I answer by matching words in the Slirc guides, without a model. I only read the Slirc guides.";
}
export const NUDGE_REPLY = `Ask me something about Slirc, like "how do I add my phone?" or "how do I make a private channel?"`;
// The instance's own welcome page, from server config like the onboarding DM.
export function firstStepsReply(): string {
  return `Your first steps and a few things worth trying are at ${new URL("/welcome", configuredAppOrigin()).href}. Ask me anything about Slirc too.`;
}

// First messages people send that the docs cannot answer well. Each gets a fixed reply with no
// model call and no cache entry. Anchored at both ends, so a longer real question still searches.
const LEAD = String.raw`^(?:(?:hi|hey|hello|so|ok(?:ay)?|and)[\s,!.]+)?`;
const END = String.raw`[\s?!.]*$`;
const GREETING = /^(?:hi|hey|hello|hiya|howdy|yo|g'?day|good (?:morning|afternoon|evening))(?:\s+(?:there|help|all|everyone))?[\s!.,]*$/i;
const ABOUT_HELP = new RegExp(`${LEAD}(?:help|are you a bot|(?:what can you |can you )?tell me about yourself|who are you|what are you|what (?:can|do) you do|what can you help(?: me)? with|how can you help(?: me)?|introduce yourself)${END}`, "i");
const FIRST_STEPS = new RegExp(`${LEAD}(?:what (?:can|should) i do(?: here)?|where (?:do|should) i start|how do i (?:get started|start))${END}`, "i");
// Short questions about the model behind help: a model, LLM or vendor word next to "you", "this",
// "use" and the like. A device question ("what model of phone…") is not one.
const MODEL_WORD = /\b(?:models?|llms?|gpt|chatgpt|claude|gemini|llama|mistral|openai|anthropic|haiku|mimo|language model|ai)\b/i;
const MODEL_ABOUT = /\b(?:you|your|you're|this|help|behind|powers?|powered|running|run|use|using|built)\b/i;
// Devices, agents and harnesses are Slirc questions even when they name a vendor.
const DEVICE = /\b(?:phone|iphone|android|ipad|laptop|computer|browser|agents?|bots?|claude code|codex|opencode|pi)\b/i;
// Questions about the product itself, not about help. The overview and About answer them.
export const PRODUCT = new RegExp(`${LEAD}(?:what(?:'s| is) (?:slirc|this(?: app| place)?)(?: for)?|what (?:can|does) slirc do|tell me about slirc)${END}`, "i");
const VAGUE = new RegExp(`${LEAD}(?:now|then|next|what now|now what|what next|what else)${END}|^(?:and|so)${END}`, "i");

export function fixedReply(question: string): Answer | null {
  const text = question.trim();
  if (GREETING.test(text)) return { kind: "smalltalk", text: SMALLTALK_REPLY, source: "", model: false };
  if (text.length <= 80 && MODEL_WORD.test(text) && MODEL_ABOUT.test(text) && !DEVICE.test(text)) return { kind: "answer", text: modelReply(), source: "", model: false };
  if (ABOUT_HELP.test(text)) return { kind: "answer", text: selfReply(), source: "", model: false };
  if (FIRST_STEPS.test(text)) return { kind: "answer", text: firstStepsReply(), source: "", model: false };
  if (VAGUE.test(text)) return { kind: "answer", text: NUDGE_REPLY, source: "", model: false };
  return null;
}

// Anything without a question in it is chatter: "zzzz", "thanks", a bare link.
const QUESTION = /\?|\b(how|what|when|where|who|which|why|can|could|should|do|does|is|are|will|would)\b|\b(have|has|need|needs|want|wants|looking|trying|tell|show|explain|help)\b[^.!?]{0,80}\b(i|me|us|you|we|my|your|our|scripts?|bots?|channels?|accounts?|connect|create|run|use|do)\b/i;

// Crude suffix fold so "invite" and "invites" are the same word.
function stem(word: string): string {
  if (SYNONYMS[word]) return SYNONYMS[word];
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

export function words(text: string): string[] {
  const folded = PHRASES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text.toLowerCase());
  return folded.match(/[a-z0-9']+/g)?.filter((word) => word.length > 1 && !STOPWORDS.has(word)).map(stem) || [];
}

// These guides open with bare `key: value` lines up to the first blank line, like build-docs reads them.
function frontMatter(markdown: string): { meta: Record<string, string>; body: string } {
  const lines = markdown.split("\n");
  const meta: Record<string, string> = {};
  let index = 0;
  for (; index < lines.length; index++) {
    if (!lines[index].trim()) break;
    const match = lines[index].match(/^([a-z-]+):\s*(.*)$/);
    if (match) meta[match[1]] = match[2];
  }
  return { meta, body: lines.slice(index).join("\n") };
}

export function docsDir(): string {
  return process.env.HELP_DOCS_DIR || join(import.meta.dir, "..", "docs");
}

// One chunk per paragraph, tagged with the guide and heading it came from, so an answer can cite
// a page and the model can read the whole section around a match. Fenced examples and markup are
// dropped: they read badly as a sentence and nobody asks for them.
export function loadDocs(dir = docsDir(), host = instanceHost()): Chunk[] {
  const chunks: Chunk[] = [];
  // design.md is the design system reference for people building Slirc; it answers no user question
  // and its UI vocabulary crowds out the guides.
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "design.md").sort()) {
    const doc = file.replace(/\.md$/, "");
    const source = readFileSync(join(dir, file), "utf8").replaceAll("{{host}}", host);
    const { meta, body } = frontMatter(source);
    const title = meta.title || doc;
    if (meta.lead) chunks.push({ doc, title, path: file, text: clean(meta.lead), section: "", lead: true });
    let section = "";
    for (const block of body.replace(/```[\s\S]*?```/g, "\n\n").split(/\n\s*\n/)) {
      const heading = block.trim().match(/^#{2,4}\s+(.+?)\s*(?:\n([\s\S]*))?$/);
      if (heading) section = clean(heading[1]);
      const text = clean(heading ? heading[2] || "" : block);
      if (text.length > 24 && !isNavigation(text)) chunks.push({ doc, title, path: file, text, section });
    }
  }
  return chunks;
}

function clean(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// "Read next: ..." lines and link lists read as gibberish in an answer.
function isNavigation(text: string): boolean {
  return /^read next/i.test(text) || (text.match(/\]\(\/docs\//g)?.length || 0) > 1;
}

let cached: Chunk[] | null = null;
let cacheCleanupScheduled = false;
let lastCacheCleanup = 0;

function scheduleCacheCleanup(): void {
  if (cacheCleanupScheduled || Date.now() - lastCacheCleanup < 60_000) return;
  cacheCleanupScheduled = true;
  const timer = setTimeout(() => {
    cacheCleanupScheduled = false;
    lastCacheCleanup = Date.now();
    db.query("DELETE FROM help_answer_cache WHERE expires_at <= ? OR rowid NOT IN (SELECT rowid FROM help_answer_cache ORDER BY expires_at DESC LIMIT 500)").run(lastCacheCleanup);
  }, 1_000);
  timer.unref?.();
}

export function corpus(): Chunk[] {
  if (!cached) cached = loadDocs();
  return cached;
}

export function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, " ").trim();
}

export function docsVersion(chunks = corpus()): string {
  // docsUrl belongs in the version: answers embed it, so a moved docs URL must
  // invalidate cached text instead of serving citations to a dead host.
  return createHash("sha256").update(`${ANSWER_CACHE_VERSION}\n${docsUrl()}\n${answerModel()}\n${classifierModel()}\n${chunks.map((chunk) => `${chunk.doc}\n${chunk.section || ""}\n${chunk.text}`).join("\n\n")}`).digest("hex").slice(0, 16);
}

function recordUsage(question: string, answer: Pick<Answer, "inputTokens" | "outputTokens" | "costUsd" | "cached">, model = answerModel()): void {
  db.query("INSERT INTO help_usage (question, model, input_tokens, output_tokens, cost_usd, cached, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(question, model, answer.inputTokens || 0, answer.outputTokens || 0, answer.costUsd || 0, answer.cached ? 1 : 0, Date.now());
}

function cachedAnswer(question: string, version: string): Answer | null {
  const row = db.query("SELECT kind, text, source, model, input_tokens, output_tokens, cost_usd, expires_at FROM help_answer_cache WHERE question = ? AND docs_version = ?").get(question, version) as { kind: Answer["kind"]; text: string; source: string; model: number; input_tokens: number; output_tokens: number; cost_usd: number; expires_at: number } | null;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.query("DELETE FROM help_answer_cache WHERE question = ? AND docs_version = ?").run(question, version);
    return null;
  }
  return { kind: row.kind, text: row.text, source: row.source, model: Boolean(row.model), inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUsd: row.cost_usd, cached: true };
}

function storeAnswer(question: string, version: string, answer: Answer): void {
  if (answer.kind === "react" || answer.kind === "smalltalk" || answer.kind === "offtopic") return;
  const ttl = answer.kind === "unknown" ? 15 * 60_000 : 24 * 60 * 60_000;
  db.query(`INSERT INTO help_answer_cache (question, docs_version, kind, text, source, model, model_name, input_tokens, output_tokens, cost_usd, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(question, docs_version) DO UPDATE SET kind = excluded.kind, text = excluded.text, source = excluded.source, model = excluded.model, model_name = excluded.model_name, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cost_usd = excluded.cost_usd, expires_at = excluded.expires_at`)
    .run(question, version, answer.kind, answer.text, answer.source, answer.model ? 1 : 0, answerModel(), answer.inputTokens || 0, answer.outputTokens || 0, answer.costUsd || 0, Date.now() + ttl);
  scheduleCacheCleanup();
}

// BM25 over paragraphs: rare words count for more, long paragraphs do not win by size alone.
export function searchDocs(question: string, chunks = corpus(), limit = 4): Hit[] {
  const query = [...new Set(words(question))];
  if (!query.length) return [];
  // Index the title and heading with the body: a guide whose title names the thing ("privacy") should
  // be found even when the prose never repeats that word.
  const tokenised = chunks.map((chunk) => words(`${chunk.title} ${chunk.section || ""} ${chunk.text}`));
  const lengths = tokenised.map((list) => list.length);
  const average = lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, chunks.length);
  const documentFrequency = new Map<string, number>();
  for (const list of tokenised) {
    const present = new Set(list);
    for (const token of query) if (present.has(token)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const k1 = 1.2;
  const b = 0.75;
  // "What is a bot?" wants the guide's own summary; "how do I upload a video?" wants the paragraph about it.
  const definition = /^\s*(what|who|which)\b|\bexplain\b/i.test(question) && query.length <= 3;
  const ranked = chunks
    .map((chunk, index) => {
      const list = tokenised[index];
      const length = lengths[index] || 1;
      let score = 0;
      for (const token of query) {
        const frequency = list.filter((word) => word === token).length;
        if (!frequency) continue;
        const seen = documentFrequency.get(token) || 1;
        const idf = Math.log(1 + (chunks.length - seen + 0.5) / (seen + 0.5));
        score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * length / average));
      }
      // A guide whose title matches the question is the page people want, and its lead is its own summary.
      if (score > 0 && words(chunk.title).some((token) => query.includes(token))) score *= 1.5;
      // Same for the heading: "Creating a channel" is the section for "how do I make a channel",
      // and a heading that holds the whole question ("What is Slirc?") is the answer.
      const heading = words(chunk.section || "");
      if (score > 0 && heading.some((token) => query.includes(token))) score *= query.every((token) => heading.includes(token)) ? 3 : 1.5;
      if (score > 0 && chunk.lead) score *= definition ? 2 : 1.3;
      return { ...chunk, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);
  // Score guides, not just paragraphs: a page that keeps coming up is the page people want.
  const byDoc = new Map<string, { score: number; hits: Hit[] }>();
  for (const hit of ranked) {
    const entry = byDoc.get(hit.doc) || { score: 0, hits: [] };
    if (entry.hits.length < 3) {
      entry.score += hit.score;
      entry.hits.push(hit);
    }
    byDoc.set(hit.doc, entry);
  }
  const hits: Hit[] = [];
  for (const entry of [...byDoc.values()].sort((a, b) => b.score - a.score)) {
    for (const hit of entry.hits.slice(0, 2)) hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}

// The plain-docs answer: first two real sentences of the best passage, not a wall of excerpts.
function excerpt(hits: Hit[], limit = 260): string {
  for (const hit of hits) {
    const text = hit.text
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/\*\*/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[-*]\s*/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    const sentences = text.split(/(?<=\.)\s/).filter((sentence) => sentence.split(" ").length > 3);
    const answer = (sentences.slice(0, 2).join(" ") || text).trim();
    if (answer.length > 40) return answer.length > limit ? `${answer.slice(0, limit).trimEnd()}…` : answer;
  }
  return hits.length ? hits[0].text.slice(0, limit) : "";
}

// Chat renders only absolute links. A relative or stale in-app link (cached answers included)
// shows as raw Markdown, so keep its label and drop the target.
export function plainRelativeLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]*\)/g, "$1").replace(/ — /g, ", ");
}

// The guide and, when the passage sits under a heading, that section. The anchor follows the
// docs build's slug rule (scripts/build-docs.ts addHeadingIds) applied to the Markdown heading.
export function docUrl(doc: string, section = ""): string {
  const base = docsUrl();
  const page = doc === "home" ? `${base}/` : `${base}/${doc}`;
  const anchor = sectionAnchor(section);
  return anchor ? `${page}#${anchor}` : page;
}

// What the link reads as in chat: host and guide, without the anchor ("docs.slirc.org/agents").
export function sourceLabel(source: string): string {
  return source.replace(/^https?:\/\//, "").replace(/#.*$/, "").replace(/\/$/, "");
}

export function sectionAnchor(section: string): string {
  return section
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

// The overview page matches loosely; when a real guide also matched, that guide is the one to cite.
export function citedHit(hits: Hit[]): Hit {
  return hits.find((hit) => hit.doc !== "home") || hits[0];
}

const SYSTEM_PROMPT = [
  "You answer questions about Slirc, a chat app built on IRC, for people in its channels.",
  "Use only the documentation excerpts in the message. Never invent settings, commands, or behaviour.",
  "The excerpts are found by keyword and often use other words than the question: a private channel is an invite-only channel, start or make means create, people in a list are contacts or members.",
  "Questions about why Slirc exists or what it drops from Slack are answered by the About and Footprint pages.",
  "If the excerpts cover the topic, answer from them even when the wording differs or the answer takes one plain step of inference, in two or three plain sentences.",
  "No headings or bullet lists, and never comment on the excerpts themselves. Do not add links; a link to the matching guide is appended after your reply. Name in-app places in words, like Profile → Agents. Never use em dashes.", 
  "If the message is not a question about Slirc (greetings, thanks, chatter, a link, a reaction to something), reply with exactly: REACT",
  "Only if nothing in the excerpts relates to the question, reply with exactly: UNKNOWN",
].join(" ");

const CLASSIFIER_PROMPT = [
  "You sort messages sent to the help bot of Slirc, a team chat app built on IRC. Reply with one word.",
  "slirc: a question or request about using or understanding Slirc, including what Slirc is, how it compares with Slack or other chat apps, channels, direct messages, people, invites, notifications, bots, privacy, and self-hosting.",
  "smalltalk: a greeting, thanks, okay, or other chatter with nothing to answer.",
  "offtopic: anything else, like unrelated requests, general knowledge, or nonsense.",
  "If unsure, reply slirc.",
].join(" ");

// OpenRouter list prices in USD per million tokens (input, output, cached input), checked 8 Oct 2026.
// OpenRouter reports what each call cost; the table only prices a response that came without it.
// HELP_INPUT/OUTPUT_PRICE_PER_MILLION override them for a model missing here.
const MODEL_PRICES: Record<string, [number, number, number]> = {
  "xiaomi/mimo-v2.6-pro": [0.435, 0.87, 0.0036],
  "xiaomi/mimo-v2.5-pro": [0.435, 0.87, 0.0036],
  "xiaomi/mimo-v2.6-flash": [0.14, 0.28, 0.0028],
  "xiaomi/mimo-v2.5": [0.14, 0.28, 0.0028],
  "qwen/qwen3.8-flash": [0.15, 0.47, 0.016],
  "anthropic/claude-haiku-5.5": [0.10, 0.50, 0.01],
};

// Env files from the OpenCode days still say "mimo-v2.5" or "claude-haiku-5-5"; those map to OpenRouter's
// vendor/model ids. An id with a slash, Jev, and anything unknown pass through.
const VENDORS: [RegExp, string][] = [[/^mimo-/, "xiaomi"], [/^qwen/, "qwen"], [/^minimax-/, "minimax"]];
export function openRouterId(model: string): string {
  if (!model || model.includes("/")) return model;
  if (model === "claude-haiku-5-5") return "anthropic/claude-haiku-5.5";
  const vendor = VENDORS.find(([pattern]) => pattern.test(model))?.[1];
  return vendor ? `${vendor}/${model}` : model;
}

export function modelCost(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const [listIn, listOut, listCached] = MODEL_PRICES[model] ?? [0.14, 0.28, 0.0028];
  const input = Number(process.env.HELP_INPUT_PRICE_PER_MILLION || listIn);
  const output = Number(process.env.HELP_OUTPUT_PRICE_PER_MILLION || listOut);
  const cached = Math.min(cachedTokens, inputTokens);
  return ((inputTokens - cached) * input + cached * listCached + outputTokens * output) / 1_000_000;
}

export type ModelUsage = { input: number; output: number; cost: number };
export type ModelOptions = { model?: string; system?: string; user?: string; maxTokens?: number; signal?: AbortSignal; onUsage?: (usage: ModelUsage) => void; timeoutMs?: number };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// One chat completion through OpenRouter. The docs helper uses the defaults;
// other helpers pass their own system prompt and model and share the key and pricing.
export async function askModel(question: string, context: string, conversation = "", options: ModelOptions = {}): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const model = openRouterId(options.model || process.env.HELP_MODEL || "xiaomi/mimo-v2.5");
  // X-Title and HTTP-Referer name the app on OpenRouter's usage pages.
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Slirc" };
  if (process.env.APP_ORIGIN) headers["HTTP-Referer"] = process.env.APP_ORIGIN;
  const system = options.system || SYSTEM_PROMPT;
  const user = options.user || `${conversation ? `Recent conversation:\n\n${conversation}\n\n` : ""}Documentation excerpts:\n\n${context}\n\nQuestion: ${question}`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers,
    // `usage.include` asks OpenRouter to put the call's cost in the usage block.
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: options.maxTokens || 320, temperature: 0.2, usage: { include: true } }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`help model returned ${response.status}`);
  const body = await response.json() as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
  };
  const usage = body.usage || {};
  const text = body.choices?.[0]?.message?.content?.trim() || "";
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const costUsd = typeof usage.cost === "number" ? usage.cost : modelCost(model, inputTokens, outputTokens, usage.prompt_tokens_details?.cached_tokens || 0);
  if (text) options.onUsage?.({ input: inputTokens, output: outputTokens, cost: costUsd });
  return text || null;
}

const SMALL_PAGE = 4_500;
const SECTION_LIMIT = 2_000;

// What the model gets to read: the whole section around each matched passage under its guide and
// heading, best match first, and a short guide in full. A paragraph alone loses the sentence next
// to it that answers the question. The budget (about 2,000 tokens) keeps a long guide from crowding
// the prompt.
export function docsContext(hits: Hit[], chunks = corpus(), budget = 8_000): string {
  const blocks: string[] = [];
  const included = new Set<string>();
  let used = 0;
  for (const hit of hits) {
    const page = chunks.filter((chunk) => chunk.doc === hit.doc);
    const whole = page.reduce((sum, chunk) => sum + chunk.text.length, 0) <= SMALL_PAGE;
    const section = hit.section || "";
    const key = whole ? hit.doc : `${hit.doc}\n${section}`;
    if (included.has(hit.doc) || included.has(key)) continue;
    included.add(key);
    let parts = whole ? page : page.filter((chunk) => (chunk.section || "") === section);
    // A long section keeps each matched paragraph and its neighbours.
    if (!whole && parts.reduce((sum, chunk) => sum + chunk.text.length, 0) > SECTION_LIMIT) {
      const matched = new Set(hits.filter((other) => other.doc === hit.doc).map((other) => other.text));
      const near = new Set<number>();
      parts.forEach((chunk, at) => { if (matched.has(chunk.text)) for (const index of [at - 1, at, at + 1]) near.add(index); });
      parts = parts.filter((_, index) => near.has(index));
    }
    const heading = whole || !section ? `## ${hit.title}` : `## ${hit.title} › ${section}`;
    const block = `${heading}\n${parts.map((chunk) => chunk.text).join("\n\n")}`;
    if (used + block.length > budget) {
      if (!blocks.length) blocks.push(block.slice(0, budget));
      continue;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}

// The question has to land somewhere: one passage holding two of its terms, or a guide or heading
// that names the thing being asked about. "how are we doing today?" matches `doing` in one paragraph
// and `today` in another, and quoting either one back is not an answer.
export function wellMatched(question: string, hits: Hit[]): boolean {
  const query = [...new Set(words(question))];
  for (const hit of hits) {
    if (words(`${hit.title} ${hit.section || ""}`).some((token) => query.includes(token))) return true;
    const body = new Set(words(hit.text));
    if (query.filter((token) => body.has(token)).length > 1) return true;
  }
  return false;
}

// Reasoning models put their chain of thought inside the content, and it is not the answer. A block cut off
// by max_tokens has no closing tag, so the unterminated case is stripped too.
export function stripThinking(reply: string): string {
  return reply
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .replace(/^[\s\S]*?<\/think>/i, " ")
    .trim();
}

// The model picks the outcome: answer, acknowledge with a reaction, or admit the docs are silent.
export function readAnswer(reply: string): Pick<Answer, "kind" | "text"> {
  const text = stripThinking(reply);
  if (/^react\b[.!]?$/i.test(text)) return { kind: "react", text: "" };
  if (/^unknown\b[.!]?$/i.test(text)) return { kind: "unknown", text: "I could not find that in the docs." };
  return { kind: "answer", text };
}

// The classifier's one word. Junk, or more than one label, is null so the caller answers anyway.
export function readLabel(reply: string | null): Label | null {
  const text = stripThinking(reply || "").toLowerCase();
  const found = new Set([...text.matchAll(/\b(slirc|small[ -]?talk|off[ -]?topic)\b/g)].map((match) =>
    match[1].startsWith("small") ? "smalltalk" as const : match[1].startsWith("off") ? "offtopic" as const : "slirc" as const));
  return found.size === 1 ? [...found][0] : null;
}

// Jev answers a multiple-choice question with a confidence. The last line of the conversation
// goes along so a follow-up like "and on my phone?" still reads as a Slirc question.
async function askJev(question: string, conversation: string): Promise<{ label: Label; confidence: number } | null> {
  const base = process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai/v1";
  const recent = conversation.trim().split("\n").at(-1)?.slice(0, 200);
  const response = await fetch(`${base}/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state: recent ? `${recent}\n${question}` : question,
      model: classifierModel(),
      questions: { intent: { type: "choice", instructions: "What is this message to the Slirc help bot?", criteria: JEV_CRITERIA } },
    }),
    signal: AbortSignal.timeout(CLASSIFIER_WAIT_MS),
  });
  if (!response.ok) throw new Error(`classifier returned ${response.status}`);
  const body = await response.json() as { answers?: { intent?: { choice?: string; confidence?: number } }; usage?: { input_tokens?: number; output_tokens?: number } };
  const inputTokens = body.usage?.input_tokens || 0;
  recordUsage(normalizeQuestion(question), { inputTokens, outputTokens: body.usage?.output_tokens || 0, costUsd: inputTokens * jevInputPrice() / 1_000_000_000 }, classifierModel());
  const choice = body.answers?.intent?.choice;
  return choice && choice in JEV_CRITERIA ? { label: choice as Label, confidence: Number(body.answers?.intent?.confidence) || 0 } : null;
}

// One cheap call before the expensive one. Any failure fails open: `sure` is false and the
// question goes on to the docs as before.
export async function classifyQuestion(question: string, conversation = "", ask: typeof askModel = askModel): Promise<{ label: Label; sure: boolean }> {
  try {
    if (process.env.TYPESAFE_API_KEY && classifierModel().startsWith("jev")) {
      const result = await askJev(question, conversation);
      if (!result || (result.label !== "slirc" && result.confidence < CLASSIFIER_CONFIDENCE)) return { label: "slirc", sure: false };
      return { label: result.label, sure: result.confidence >= CLASSIFIER_CONFIDENCE };
    }
    let used: ModelUsage | null = null;
    const recent = conversation ? `Recent conversation:\n${conversation.slice(-600)}\n\n` : "";
    const reply = await ask(question, "", conversation, { model: classifierModel(), system: CLASSIFIER_PROMPT, user: `${recent}Message: ${question}`, maxTokens: 64, onUsage: (usage) => { used = usage; } });
    const usage = used as ModelUsage | null;
    if (usage) recordUsage(normalizeQuestion(question), { inputTokens: usage.input, outputTokens: usage.output, costUsd: usage.cost }, classifierModel());
    const label = readLabel(reply);
    return label ? { label, sure: true } : { label: "slirc", sure: false };
  } catch (error) {
    console.error("help classifier failed:", error instanceof Error ? error.message : error);
    return { label: "slirc", sure: false };
  }
}

// Resolves null once `ms` pass and leaves the promise to finish on its own.
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The answer model's reply and what it cost; null when it failed, came back empty, or was aborted.
async function draftAnswer(question: string, context: string, conversation: string, ask: typeof askModel, signal: AbortSignal): Promise<{ reply: string; usage: ModelUsage } | "failed" | null> {
  let usage: ModelUsage = { input: 0, output: 0, cost: 0 };
  try {
    // Answers cut mid-sentence at 320 tokens; Haiku's run 250 to 350.
    const reply = await ask(question, context, conversation, { model: answerModel(), maxTokens: 600, signal, timeoutMs: ANSWER_TIMEOUT_MS, onUsage: (used) => { usage = used; } });
    const cleaned = reply ? stripThinking(reply) : "";
    return cleaned ? { reply: cleaned, usage } : null;
  } catch (error) {
    if (signal.aborted) return null;
    console.error("help model failed:", error instanceof Error ? error.message : error);
    return "failed";
  }
}

// The docs search always runs; the models only sort, decide, and rewrite when configured and reachable.
export async function answerFromDocs(question: string, options: { corpus?: Chunk[]; ask?: typeof askModel; allowModel?: boolean; conversation?: string; onAnswering?: () => void; classifierWait?: number } = {}): Promise<Answer> {
  // Fixed replies come first, so an older cached answer to the same words never wins.
  const fixed = fixedReply(question);
  if (fixed) return fixed;
  const normalizedQuestion = normalizeQuestion(question);
  const chunks = options.corpus || corpus();
  const version = docsVersion(chunks);
  const allowModel = options.allowModel !== false;
  const useCache = !options.conversation && !options.ask && allowModel;
  if (useCache) {
    const cached = cachedAnswer(normalizedQuestion, version);
    if (cached) { recordUsage(normalizedQuestion, cached); return cached; }
  }
  const ask = options.ask || askModel;
  // Earlier questions help a follow-up land. Help's own replies would only pull in the overview
  // page, and a question that got a fixed reply ("who are you?") carries no topic.
  const asked = (options.conversation || "").split("\n")
    .filter((line) => !/^Help:/.test(line) && !(line.startsWith("Person: ") && fixedReply(line.slice(8)))).join("\n");
  const searchQuestion = asked.trim() ? `${asked}\n${question}` : question;
  // "What is Slirc?" and "what can Slirc do?" read the overview's own answer and cite About.
  const product = PRODUCT.test(question.trim());
  const about = chunks.find((chunk) => chunk.doc === "about" && chunk.lead);
  const hits = product && about ? [{ ...about, score: 1 }, ...searchDocs("what is Slirc?", chunks, 5)] : searchDocs(searchQuestion, chunks, 6);
  // The classifier and the answer model start together. Jev usually answers in 0.2s but now and
  // then hangs for seconds, and the answer should not queue behind it.
  const sorting = allowModel ? classifyQuestion(question, options.conversation || "", ask) : null;
  const abort = new AbortController();
  const answering = allowModel && hits.length ? draftAnswer(question, docsContext(hits, chunks), options.conversation || "", ask, abort.signal) : null;
  // A label that misses the window counts as unsure, so the keyword check below decides.
  const sorted = (sorting && await within(sorting, options.classifierWait ?? CLASSIFIER_WAIT_MS)) || { label: "slirc" as const, sure: false };
  // Chatter and unrelated requests get a fixed line; the answer in flight is aborted and never logged.
  if (sorted.label !== "slirc") abort.abort();
  if (sorted.label === "offtopic") return { kind: "offtopic", text: OFFTOPIC_REPLY, source: "", model: false };
  if (sorted.label === "smalltalk") return { kind: "smalltalk", text: SMALLTALK_REPLY, source: "", model: false };
  // No usable match. A real question gets the honest line; chatter and accidental matches
  // ("how are you today") get a reaction instead of an unrelated paragraph. A question the
  // classifier called a Slirc question goes to the model with whatever the search found.
  if (!hits.length || (!product && !sorted.sure && !wellMatched(question, hits))) {
    abort.abort();
    const asksForHelp = QUESTION.test(question) && !/^how are (you|we)\b/i.test(question.trim());
    const answer = asksForHelp
      ? { kind: "unknown" as const, text: `I could not find that in the docs. ${docsUrl()} has the guides.`, source: "", model: false }
      : { kind: "react" as const, text: "", source: "", model: false };
    if (useCache) storeAnswer(normalizedQuestion, version, answer);
    return answer;
  }
  const cited = product ? hits[0] : citedHit(hits);
  const source = docUrl(cited.doc, cited.section);
  if (answering) {
    // Only a real question reaches here, so this is when the helper starts showing it is typing.
    options.onAnswering?.();
    const draft = await answering;
    // A failed or timed-out call says so and points at the guide; it is never cached, so the next ask retries.
    if (draft === "failed") return { kind: "answer", text: UNREACHABLE_REPLY, source, model: false };
    // Nothing but reasoning came back: better the grounded excerpt than a message with no answer in it.
    if (draft) {
      const { kind, text } = readAnswer(draft.reply);
      const usage = draft.usage;
      if (kind === "react") return { kind, text: "", source: "", model: true };
      if (kind === "unknown") {
        const answer = { kind, text, source: "", model: true, inputTokens: usage.input, outputTokens: usage.output, costUsd: usage.cost };
        if (useCache) storeAnswer(normalizedQuestion, version, answer);
        recordUsage(normalizedQuestion, answer);
        return answer;
      }
      const answer = { kind, text, source, model: true, inputTokens: usage.input, outputTokens: usage.output, costUsd: usage.cost };
      if (useCache) storeAnswer(normalizedQuestion, version, answer);
      recordUsage(normalizedQuestion, answer);
      return answer;
    }
  }
  const answer = { kind: "answer" as const, text: excerpt(hits), source, model: false, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (useCache) storeAnswer(normalizedQuestion, version, answer);
  recordUsage(normalizedQuestion, answer);
  return answer;
}

import { parseDuration } from "./duration.ts";

// The rules for a typed poll ("@poll Lunch? pizza, sushi"), shared by the poll helper and the app's
// composer so both agree on what makes a poll. Pure: no database, no Node APIs.

export type ParsedPoll = { question: string; options: string[]; closesAt: number | null; named: boolean; multi?: boolean };
// What a refused poll still said, so the app can open its dialog with it. `field` is where to fix it;
// `index` is the option at fault, when one is.
export type PollDraft = { question: string; options: string[]; closesIn: number | null; named: boolean };
export type PollRefusal = { error: string; draft: PollDraft; field: "question" | "options" | "closes"; index?: number };

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
// Short enough that the announcement and each tally line stay well inside IRC's 512-byte line.
export const MAX_QUESTION = 200;
export const MAX_OPTION = 80;
// Ergo refuses a whole multiline batch with 417 when one relayed line, source and target
// included, passes 512 bytes. A long nick, host and channel take up to about 170 of them, so each
// line of text the helper posts stays within LINE_BYTES. Questions and options are capped in
// bytes too, because emoji and accents take several bytes a character.
export const LINE_BYTES = 340;
export const MAX_QUESTION_BYTES = 280;
export const MAX_OPTION_BYTES = 200;
// A poll nobody closes would block the next one forever, so every poll has an end.
export const DEFAULT_SPAN_MS = 7 * 86_400_000;
export const MAX_SPAN_MS = 30 * 86_400_000;
// The one example the helper offers after a refused poll.
export const POLL_EXAMPLE = "Lunch? pizza, sushi, tacos";

const encoder = new TextEncoder();
export const bytes = (text: string) => encoder.encode(text).length;
// Line breaks or other control characters would add lines of their own to the announcement.
export const CONTROL = /[\u0000-\u001f\u007f]/;

const longQuestion = (question: string) => question.length > MAX_QUESTION || bytes(question) > MAX_QUESTION_BYTES;
const longOption = (option: string) => option.length > MAX_OPTION || bytes(option) > MAX_OPTION_BYTES;

export function sizeError(question: string, options: string[]): string | null {
  if (longQuestion(question)) return `Keep the question under ${MAX_QUESTION} characters.`;
  if (options.some(longOption)) return `Keep each option under ${MAX_OPTION} characters.`;
  return null;
}

// What an "@poll …" request asks for. Anything that is not help, results, close or a vote is a new poll.
export type PollIntent = { kind: "help" | "results" | "close" } | { kind: "vote"; option: number } | { kind: "create"; text: string };
export function pollIntent(request: string): PollIntent {
  const command = request.trim();
  if (!command || /^help$/i.test(command)) return { kind: "help" };
  if (/^(results?|tally|status)$/i.test(command)) return { kind: "results" };
  if (/^(close|end|finish)$/i.test(command)) return { kind: "close" };
  const ballot = command.match(/^#?(\d{1,2})\.?$/);
  if (ballot) return { kind: "vote", option: Number(ballot[1]) };
  return { kind: "create", text: command };
}

// Trailing flags: "... for 1h", "... named", in either order. Everything before them is the poll.
function stripFlags(input: string): { body: string; closesIn: number | null; named: boolean; badDuration: boolean } {
  let body = input.trim();
  let closesIn: number | null = null;
  let named = false;
  let badDuration = false;
  for (let pass = 0; pass < 2; pass++) {
    const namedMatch = body.match(/\s+named$/i);
    if (namedMatch && !named) {
      named = true;
      body = body.slice(0, namedMatch.index).trim();
      continue;
    }
    const forMatch = body.match(/\s+for\s+(\d{1,4}\s*[a-z]+)$/i);
    if (forMatch && closesIn === null) {
      const span = parseDuration(forMatch[1]!);
      if (span === null) badDuration = true;
      else closesIn = span;
      body = body.slice(0, forMatch.index).trim();
    }
  }
  return { body, closesIn, named, badDuration };
}

// Options split on commas; without a comma they split on " or ".
function splitOptions(text: string): string[] {
  const parts = text.includes(",") ? text.split(",") : text.split(/\s+or\s+/i);
  return parts.map((part) => part.trim().replace(/[?.!]+$/, "").trim()).filter(Boolean);
}

// "Lunch? pizza, sushi, salad" and "pizza or sushi?" are both polls. The question ends at the
// first question mark; when nothing follows it, the options come from the question itself.
export function parsePoll(input: string, now = Date.now()): ParsedPoll | PollRefusal {
  const { body, closesIn, named, badDuration } = stripFlags(input);
  const mark = body.indexOf("?");
  let question = body;
  let optionText = body;
  if (mark !== -1 && mark < body.length - 1) {
    question = body.slice(0, mark + 1).trim();
    optionText = body.slice(mark + 1).trim();
  }
  const options = body ? splitOptions(optionText) : [];
  // Without a question mark the options came from the question; when they don't make a poll, the
  // text is only a question.
  const split = optionText !== question;
  const draft: PollDraft = { question, options: split || options.length >= MIN_OPTIONS ? options : [], closesIn, named };
  const refuse = (error: string, field: PollRefusal["field"], index?: number): PollRefusal => ({ error, draft, field, ...(index === undefined ? {} : { index }) });
  if (badDuration) return refuse("I did not understand that duration. Try for 30m, for 2h, or for 1d.", "closes");
  if (closesIn !== null && (closesIn < 60_000 || closesIn > MAX_SPAN_MS)) return refuse("A poll can run from 1 minute to 30 days.", "closes");
  if (!body) return refuse("Give me a question and at least two options.", "question");
  if (options.length < MIN_OPTIONS) return refuse(`A poll needs at least ${MIN_OPTIONS} options, separated by commas or "or".`, "options", draft.options.length);
  if (options.length > MAX_OPTIONS) return refuse(`A poll can have at most ${MAX_OPTIONS} options.`, "options", MAX_OPTIONS);
  const seen = options.map((option) => option.toLowerCase());
  const repeat = seen.findIndex((option, index) => seen.indexOf(option) !== index);
  if (repeat !== -1) return refuse("Each option has to be different.", "options", repeat);
  const tooBig = sizeError(question, options);
  if (tooBig) return longQuestion(question) ? refuse(tooBig, "question") : refuse(tooBig, "options", options.findIndex(longOption));
  return { question, options, closesAt: now + (closesIn ?? DEFAULT_SPAN_MS), named };
}

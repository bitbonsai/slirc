export type TextSegment = {
  text: string;
  href?: string;
  nick?: string;
  channel?: string;
  format?: "strong" | "em" | "code" | "fence";
  code?: string;
  lang?: string;
  raw?: string;
  sourceStart?: number;
};

// CTCP ACTION (`/me`) arrives as `\x01ACTION text\x01`. Keep the wire text intact in storage and
// strip only for display, so edits, quotes and history all keep round-tripping.
const ACTION_RE = /^\x01ACTION ?([\s\S]*)\x01$/;
export function isActionText(text: string): boolean {
  return ACTION_RE.test(text);
}
export function actionBody(text: string): string {
  const match = ACTION_RE.exec(text);
  return match ? match[1]! : text;
}

// Match complete Markdown tokens first so their URLs and @names stay out of other parsers.
const INLINE_TOKEN = /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*(?!\*)[^*\n]+\*(?!\*)|(?<!_)_(?!_)[^_\n]+_(?!_)|https?:\/\/[^\s<>"']+|(?<![\w@.])@[A-Za-z0-9_\-\[\]\\^{}|`]{1,32}(?![A-Za-z0-9_\-\[\]\\^{}|`])|(?<![\w#&/.@-])#[a-z][a-z0-9_-]{1,31}(?![a-z0-9_-])/gi;

const QUOTE_LINK = /\s+(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"']+)$/;

const LIST_ITEM = /^([-*•]|\d{1,9}\.) +(?=\S)/;

export type DisplaySegment<T extends TextSegment> = T & { quote?: boolean; route?: boolean; marker?: string; parts?: DisplaySegment<T>[] };

// Display only, on top of the inline segments. A line starting with "> " shows as a quote block, and
// a link ending that line stays a link after the block, so a remembered message keeps its way back.
// A line starting with "- ", "* ", "• " or "1. " shows as a list item: `marker` is a bullet or the
// typed number, `parts` the line's inline segments. "• " covers lists pasted from notes and docs.
// The source text stays plain lines for IRC clients.
// A bare link to a message on this instance shows `linkLabel`'s short label; href keeps the full URL.
// Text with a code fence keeps its lines as they are, so a quoted line inside code stays code.
export function displaySegments<T extends TextSegment>(text: string, inline: (text: string) => T[], linkLabel: (href: string) => string | null = () => null): DisplaySegment<T>[] {
  const out: DisplaySegment<T>[] = [];
  const segments = (chunk: string, offset: number) => inline(chunk).map((segment) => {
    const label = segment.href && !segment.raw?.startsWith("[") ? linkLabel(segment.href) : null;
    return { ...segment, ...(segment.sourceStart === undefined ? {} : { sourceStart: segment.sourceStart + offset }), ...(label ? { text: label, route: true } : {}) } as DisplaySegment<T>;
  });
  const add = (chunk: string, offset: number) => { out.push(...segments(chunk, offset)); };
  if (text.includes("```") || !/^(> |[-*•] +\S|\d{1,9}\. +\S)/m.test(text)) { add(text, 0); return out.length ? out : [{ text } as DisplaySegment<T>]; }
  const lines = text.split("\n");
  let offset = 0, plain = "", plainStart = 0;
  lines.forEach((line, index) => {
    const end = index < lines.length - 1 ? "\n" : "";
    const link = line.startsWith("> ") ? line.match(QUOTE_LINK) : null;
    const body = line.startsWith("> ") ? line.slice(2, link ? link.index : undefined).trim() : "";
    const item = body ? null : line.match(LIST_ITEM);
    if (!body && !item) {
      if (!plain) plainStart = offset;
      plain += line + end;
    } else {
      if (plain) { add(plain, plainStart); plain = ""; }
      if (item) {
        const rest = line.slice(item[0].length);
        out.push({ text: rest, marker: /\d/.test(item[1]!) ? item[1]! : "•", parts: segments(rest, offset + item[0].length) } as DisplaySegment<T>);
      } else {
        out.push({ text: body, quote: true } as DisplaySegment<T>);
        if (link) add(link[1]! + end, offset + link.index! + link[0].length - link[1]!.length);
      }
    }
    offset += line.length + end.length;
  });
  if (plain) add(plain, plainStart);
  return out;
}

// Enter on a list line in the composer: continue with the next marker, or end the list when the
// item is still empty. Returns the source range to replace and its replacement, or null for a
// plain newline. `caret` is a source offset; a caret inside the marker gets a plain newline.
export function listEnter(text: string, caret: number): { start: number; end: number; insert: string } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const lineEnd = text.indexOf("\n", caret) === -1 ? text.length : text.indexOf("\n", caret);
  const line = text.slice(lineStart, lineEnd);
  const match = line.match(/^([-*•]|\d{1,9}\.) +/);
  if (!match || caret - lineStart < match[0].length) return null;
  if (!line.slice(match[0].length).trim()) return { start: lineStart, end: lineEnd, insert: "" };
  const marker = match[1]!.endsWith(".") ? `${Number(match[1]!.slice(0, -1)) + 1}.` : match[1]!;
  return { start: caret, end: caret, insert: `\n${marker} ` };
}

// Text stays textContent; the only HTML-producing path is Glow's escaped code highlighter.
export function textSegments(text: string): TextSegment[] {
  const result: TextSegment[] = [];
  let end = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > end) result.push({ text: text.slice(end, start) });
    if (token.startsWith("```")) {
      let code = token.slice(3, -3).replace(/\n$/, "");
      let lang = "";
      const newline = code.indexOf("\n");
      if (newline !== -1) {
        const head = code.slice(0, newline).trim();
        if (/^[a-z0-9_+#.-]+$/i.test(head)) { lang = head; code = code.slice(newline + 1); }
        else if (!head) code = code.slice(newline + 1);
      }
      result.push({ text: code, format: "fence", code, lang, raw: token, sourceStart: start });
      end = start + token.length;
      continue;
    }
    if (token.startsWith("`")) {
      result.push({ text: token.slice(1, -1), format: "code", raw: token, sourceStart: start });
      end = start + token.length;
      continue;
    }
    if (token.startsWith("**") || token.startsWith("__")) {
      result.push({ text: token.slice(2, -2), format: "strong", raw: token, sourceStart: start });
      end = start + token.length;
      continue;
    }
    if (token.startsWith("*") || token.startsWith("_")) {
      result.push({ text: token.slice(1, -1), format: "em", raw: token, sourceStart: start });
      end = start + token.length;
      continue;
    }
    if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const rawUrl = token.slice(split + 2, -1);
      try {
        const url = new URL(rawUrl);
        if (url.protocol === "http:" || url.protocol === "https:") {
          result.push({ text: label, href: url.href, raw: token, sourceStart: start });
          end = start + token.length;
          continue;
        }
      } catch { /* malformed links remain inert text */ }
      result.push({ text: token });
      end = start + token.length;
      continue;
    }
    const raw = token.replace(/[),.!?;:]+$/, "");
    if (raw.startsWith("@")) {
      result.push({ text: raw, nick: raw.slice(1) });
      end = start + raw.length;
      continue;
    }
    if (raw.startsWith("#")) {
      result.push({ text: token, channel: token.toLowerCase() });
      end = start + token.length;
      continue;
    }
    if (raw) {
      try {
        const url = new URL(raw);
        if (url.protocol === "http:" || url.protocol === "https:") {
          result.push({ text: raw, href: url.href, raw, sourceStart: start });
          end = start + raw.length;
          continue;
        }
      } catch { /* retain malformed input as text */ }
    }
    result.push({ text: token });
    end = start + token.length;
  }
  if (end < text.length) result.push({ text: text.slice(end) });
  return result.length ? result : [{ text }];
}

// A #channel mention opens that channel when the reader has it, through the same in-app route a
// message link uses; any other #word stays plain text, so a name nobody can open never looks
// like a link.
export function channelLinks<T extends TextSegment>(segments: T[], canOpen: (channel: string) => boolean, origin: string): T[] {
  return segments.map((segment) => {
    if (!segment.channel) return segment;
    const { channel, ...plain } = segment;
    return (canOpen(channel) ? { ...segment, href: new URL(`/${channel}`, origin).href, route: true } : plain) as T;
  });
}

export function hasUnclosedCodeFence(text: string): boolean {
  return (text.match(/```/g)?.length ?? 0) % 2 === 1;
}

export function closeUnclosedCodeFence(text: string): string {
  if (!hasUnclosedCodeFence(text)) return text;
  return `${text}${text.endsWith("\n") ? "" : "\n"}\`\`\``;
}

export function linkPasteReplacement(value: string, start: number, end: number, pasted: string): string | null {
  if (start === end) return null;
  let url: string;
  try {
    const parsed = new URL(pasted.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    url = parsed.href.replace(/\)/g, "%29");
  } catch { return null; }
  const label = value.slice(start, end);
  if (!label || /[\n\r\]]/.test(label)) return null;
  return `[${label}](${url})`;
}

export function embedImageUrl(href: string): string {
  return `/api/embed/image?url=${encodeURIComponent(href)}`;
}

export function youtubeId(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return null;
    const id = url.hostname === "youtu.be" ? url.pathname.slice(1)
      : ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)
        ? url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1]
        : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

if (import.meta.main) {
  const segments = textSegments("watch javascript:alert(1) https://youtu.be/dQw4w9WgXcQ.");
  if (segments.some((segment) => segment.href?.startsWith("javascript:")) || segments[1]?.text !== "https://youtu.be/dQw4w9WgXcQ" || youtubeId(segments[1].href!) !== "dQw4w9WgXcQ" || youtubeId("http://youtu.be/dQw4w9WgXcQ") !== null || embedImageUrl("https://img.test/a?b=c") !== "/api/embed/image?url=https%3A%2F%2Fimg.test%2Fa%3Fb%3Dc") throw new Error("render self-check failed");
}

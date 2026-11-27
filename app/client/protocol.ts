import { type Operation } from "@client/model.ts";
import { CONCAT_TAG, wireParts } from "../shared/multiline.ts";
import { parseIrcLine } from "@client/irc.ts";
import { SendRefusedError } from "@client/outbox.ts";
import { actionBody, isActionText } from "@client/render.ts";

export const DEV_CHANNEL = "#dev-test";

export const MAX_TEXT_BYTES = 350;

export const DATA_CAPS = [
  "echo-message",
  "batch",
  "server-time",
  "account-tag",
  "message-tags",
  "draft/chathistory",
  "draft/event-playback",
] as const;

export const REQUIRED_CAPS = ["sasl", ...DATA_CAPS] as const;

export const OPTIONAL_CAPS = ["draft/multiline", "draft/message-redaction", "draft/read-marker", "away-notify", "extended-monitor"] as const;

export interface TextValidation {
  ok: boolean;
  error?: string;
}

export function validateText(text: string): TextValidation {
  if (!text || !text.trim()) return { ok: false, error: "Type something first." };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: "One line, no control characters." };
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    return { ok: false, error: `Max ${MAX_TEXT_BYTES} bytes.` };
  }
  return { ok: true };
}

export function missingRequiredCaps(enabled: Iterable<string>): string[] {
  const present = new Set(enabled);
  return REQUIRED_CAPS.filter((cap) => !present.has(cap));
}

export function escapeTag(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\:").replace(/ /g, "\\s").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function reactionTagMessage(target: string, messageServerId: string, emoji: string, remove: boolean): string {
  if (!/^#[a-z0-9][a-z0-9_-]{0,63}$/i.test(target)) throw new Error("invalid reaction target");
  if (!messageServerId || /[\u0000-\u0020\u007f]/.test(messageServerId)) throw new Error("invalid reaction message");
  if (!emoji || /[\u0000-\u001f\u007f]/.test(emoji) || new TextEncoder().encode(emoji).length > 64) throw new Error("invalid reaction emoji");
  const reply = escapeTag(messageServerId);
  const value = escapeTag(emoji);
  return `@+reply=${reply};+draft/reply=${reply};+draft/${remove ? "unreact" : "react"}=${value} TAGMSG ${target}`;
}

export const MAX_MULTILINE_BYTES = 4000;

export function validateMultiline(lines: readonly string[]): TextValidation {
  if (!lines.length || !lines.some((line) => line.trim())) return { ok: false, error: "Type something first." };
  if (lines.some((line) => /[\u0000-\u001f\u007f]/.test(line))) return { ok: false, error: "No control characters." };
  if (new TextEncoder().encode(lines.join("\n")).length > MAX_MULTILINE_BYTES) {
    return { ok: false, error: `Max ${MAX_MULTILINE_BYTES} bytes.` };
  }
  return { ok: true };
}

export function serializeOperation(
  operation: Operation,
  target: string,
  multiline: boolean,
  newBatchId: () => string = () => `ml-${randomId()}`,
): string[] {
  const editTag = operation.editOf ? `;+draft/edit=${operation.editOf}` : "";
  if (operation.replyTo && !/^[a-z0-9_-]{1,512}$/i.test(operation.replyTo)) throw new SendRefusedError("invalid reply target");
  const replyTag = operation.replyTo ? `;+reply=${escapeTag(operation.replyTo)}` : "";
  const broadcastTag = operation.broadcast ? ";+slirc/broadcast=1" : "";
  if (operation.text.includes("\n")) {
    if (!multiline) throw new SendRefusedError("multiline not supported by this server");
    const lines = operation.text.split("\n");
    const check = validateMultiline(lines);
    if (!check.ok) throw new SendRefusedError(check.error ?? "invalid multiline text");
    // The batch tag only reaches Ergo when it rides each constituent message; without it the
    // lines land as separate messages and the root quote never completes. The edit tag rides the
    // opener with +slirc/cid.
    const batch = newBatchId();
    return [
      `@+slirc/cid=${operation.id}${editTag}${replyTag}${broadcastTag} BATCH +${batch} draft/multiline ${target}`,
      // A line longer than Ergo's 512-byte limit would be dropped; it goes as concat parts.
      ...wireParts(operation.text, target).map((part) => `@batch=${batch}${part.concat ? `;${CONCAT_TAG}` : ""} PRIVMSG ${target} :${part.text}`),
      `BATCH -${batch}`,
    ];
  }
  // An action's control-character envelope is ours; validate the human text inside it.
  const check = validateText(isActionText(operation.text) ? actionBody(operation.text) : operation.text);
  if (!check.ok) throw new SendRefusedError(check.error ?? "invalid text");
  return [`@+slirc/cid=${operation.id}${editTag}${replyTag}${broadcastTag} PRIVMSG ${target} :${operation.text}`];
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // ponytail: plain-http dev hosts (no secure context) lack randomUUID; one tab cannot collide.
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function saslToken(account: string): string {
  // The relay replaces any non-PLAIN AUTHENTICATE response, so the value only has to be a token.
  try {
    return btoa(`\0${account}\0relay-placeholder`);
  } catch {
    return btoa("relay-placeholder");
  }
}

export class LineFramer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
    }
    return lines;
  }

  reset(): void {
    this.buffer = "";
  }
}

export type SaslStage = "none" | "listing" | "requested" | "auth" | "sent" | "done";

export interface RelayBridgeOptions {
  nick: string;
  saslToken: string;
  send(line: string): void;
  push(line: string): void;
  onCaps?(enabled: Set<string>, missing: string[]): void;
  onAuthenticated?(): void;
  onAuthFailed?(reason: string): void;
}

export class RelayBridge {
  readonly offered = new Set<string>();
  readonly enabled = new Set<string>();
  missing: string[] = [];
  saslStage: SaslStage = "none";
  private readonly framer = new LineFramer();

  constructor(private readonly opts: RelayBridgeOptions) {}

  onOpen(): void {
    this.offered.clear();
    this.enabled.clear();
    this.missing = [];
    this.saslStage = "none";
    this.opts.send("CAP LS 302");
    this.opts.send(`NICK ${this.opts.nick}`);
    this.opts.send(`USER ${this.opts.nick} 0 * :${this.opts.nick}`);
  }

  feed(chunk: string): void {
    for (const line of this.framer.push(chunk)) {
      this.control(line);
      // Same line, one event lane: the assembler in sync.ts parses it and is the only producer of
      // ProtocolEvents. The control handler above reacts to CAP/PING/AUTH and emits nothing.
      this.opts.push(`${line}\r\n`);
    }
  }

  reset(): void {
    this.framer.reset();
    this.saslStage = "none";
    this.offered.clear();
    this.enabled.clear();
  }

  private control(line: string): void {
    const message = parseIrcLine(line);
    if (!message) return;
    const { command, params } = message;
    if (command === "PING") {
      this.opts.send(`PONG :${params.at(-1) ?? ""}`);
      return;
    }
    if (command === "CAP") {
      const sub = params[1];
      if (sub === "LS" && (this.saslStage === "none" || this.saslStage === "listing")) {
        this.saslStage = "listing";
        for (const cap of (params.at(-1) ?? "").split(" ")) {
          if (cap) this.offered.add(cap.split("=", 1)[0]);
        }
        if (params[2] === "*") return; // more LS lines follow
        this.saslStage = "requested";
        const wanted = [...REQUIRED_CAPS, ...OPTIONAL_CAPS].filter((cap) => this.offered.has(cap));
        this.opts.send(`CAP REQ :${wanted.join(" ")}`);
        return;
      }
      if (sub === "ACK" && this.saslStage === "requested") {
        for (const cap of (params.at(-1) ?? "").split(" ")) {
          if (cap) this.enabled.add(cap.split("=", 1)[0]);
        }
        this.missing = missingRequiredCaps(this.enabled);
        this.opts.onCaps?.(this.enabled, this.missing);
        this.saslStage = "auth";
        this.opts.send("AUTHENTICATE PLAIN");
        return;
      }
      return;
    }
    if (command === "AUTHENTICATE" && this.saslStage === "auth") {
      this.saslStage = "sent";
      this.opts.send(`AUTHENTICATE ${this.opts.saslToken}`);
      return;
    }
    if (command === "903") {
      this.saslStage = "done";
      this.opts.send("CAP END");
      this.opts.onAuthenticated?.();
      return;
    }
    if (command === "904") {
      this.opts.onAuthFailed?.(params.at(-1) || "authentication refused");
    }
  }
}

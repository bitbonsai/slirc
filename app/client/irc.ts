// IRCv3 parsing and batch assembly for the browser client. No socket, no DOM, no Dexie: bytes in,
// complete lines and complete batches out. The app relay bridge owns the WebSocket; this module
// owns framing so a fragmented read can never produce a half line or a half message.
//
// Live protocol findings this encodes (checks C1/C6 in .plans/instant-checks.md):
//   - a multiline batch carries `+slirc/cid` on the `BATCH +id draft/multiline` opener only;
//   - CHATHISTORY replies are a `chathistory` batch that may contain nested `draft/multiline`
//     batches (a multiline history message replays as an inner batch, not flat PRIVMSGs);
//   - only a closed batch is delivered: an interrupted one is dropped with no checkpoint.
// The local Ergo is not reachable from this worktree, so these shapes are exercised against the
// recorded transcripts plus a runnable protocol fake; live behavior is unverified here.

export interface IrcMessage {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

export interface RawIrcMessage extends IrcMessage {
  /** The exact line between framing, before parsing. Bound memory is judged on this length. */
  raw: string;
}

// IRCv3 message-tag escapes: \: -> ; \s -> space \\ -> \ \r \n -> CR LF. A trailing lone backslash
// is dropped. Same table the server-side parser uses, kept local so the browser bundle never pulls
// node:net/node:tls through app/src/irc.ts.
function unescapeTagValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    i += 1;
    if (next === ":") out += ";";
    else if (next === "s") out += " ";
    else if (next === "\\") out += "\\";
    else if (next === "r") out += "\r";
    else if (next === "n") out += "\n";
    else if (next !== undefined) out += next;
  }
  return out;
}

// One IRC message. Returns null for anything that is not a command (blank, tags without a command,
// a prefix without a command). Command case is preserved; the wire sends uppercase and numerics.
export function parseIrcLine(line: string): IrcMessage | null {
  if (!line) return null;
  let rest = line;
  const tags: Record<string, string> = {};

  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    for (const part of rest.slice(1, sp).split(";")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq === -1) tags[part] = "";
      else tags[part.slice(0, eq)] = unescapeTagValue(part.slice(eq + 1));
    }
    rest = rest.slice(sp + 1);
  }

  rest = rest.replace(/^ +/, "");
  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).replace(/^ +/, "");
  }
  if (!rest) return null;

  let command: string;
  let params: string[];
  const trailingAt = rest.indexOf(" :");
  if (trailingAt === -1) {
    const parts = rest.split(" ").filter((part) => part.length > 0);
    command = parts.shift() ?? "";
    params = parts;
  } else {
    const parts = rest.slice(0, trailingAt).split(" ").filter((part) => part.length > 0);
    command = parts.shift() ?? "";
    params = parts.concat([rest.slice(trailingAt + 2)]);
  }
  if (!command) return null;
  return { tags, prefix, command, params };
}

export type BatchItem =
  | { kind: "line"; message: IrcMessage }
  | { kind: "batch"; id: string; batch?: IrcBatch };

export interface IrcBatch {
  id: string;
  type: string;
  /** Batch opener params after the type, e.g. `["#room"]` for `BATCH +id chathistory #room`. */
  params: string[];
  /** Opener tags, including `+slirc/cid` on a multiline opener (C1). */
  tags: Record<string, string>;
  items: BatchItem[];
  complete: true;
}

export interface BatchAssemblerOptions {
  onLine(message: IrcMessage): void;
  onBatch(batch: IrcBatch): void;
  /** Optional: a line or batch was dropped for a bound or a protocol violation. */
  onDrop?(batchId: string, reason: string): void;
  maxLineBytes?: number;
  maxOpenBatches?: number;
  maxBatchBytes?: number;
  maxBatchLines?: number;
  maxNesting?: number;
}

interface OpenBatch {
  id: string;
  type: string;
  params: string[];
  tags: Record<string, string>;
  parentId?: string;
  depth: number;
  items: BatchItem[];
  bytes: number;
  lines: number;
  poisoned?: string;
}

const DEFAULTS = {
  maxLineBytes: 64 * 1024,
  maxOpenBatches: 64,
  maxBatchBytes: 1024 * 1024,
  maxBatchLines: 8192,
  maxNesting: 4,
};

// Byte-in, lines-and-complete-batches-out. A batch is only ever delivered by its matching close,
// and `reset()` drops every unfinished batch (a disconnect must not advance progress).
export class BatchAssembler {
  private readonly opts: Required<Pick<BatchAssemblerOptions,
    "maxLineBytes" | "maxOpenBatches" | "maxBatchBytes" | "maxBatchLines" | "maxNesting">> & BatchAssemblerOptions;
  private buf = "";
  private decoder?: TextDecoder;
  private readonly batches = new Map<string, OpenBatch>();

  constructor(options: BatchAssemblerOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  push(chunk: string | Uint8Array): void {
    if (typeof chunk === "string") {
      this.buf += chunk;
    } else {
      this.decoder ??= new TextDecoder("utf-8");
      // stream:true keeps a multibyte character split across two reads from becoming U+FFFD.
      this.buf += this.decoder.decode(chunk, { stream: true });
    }

    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.consumeLine(line);
    }

    // A single line longer than the cap is a protocol violation; drop it rather than grow forever.
    if (this.buf.length > this.opts.maxLineBytes) {
      this.opts.onDrop?.("", "line-too-long");
      this.buf = "";
    }
  }

  get openBatchCount(): number {
    return this.batches.size;
  }

  // Disconnect: every unfinished batch is discarded without reaching onBatch. The in-flight
  // decoder is dropped too, so a sliced character cannot surface after reconnect.
  reset(reason = "reset"): void {
    for (const [id, batch] of this.batches) this.opts.onDrop?.(id, reason);
    this.batches.clear();
    this.buf = "";
    this.decoder = undefined;
  }

  private consumeLine(line: string): void {
    if (!line) return;
    const message = parseIrcLine(line);
    if (!message) return;

    if (message.command === "BATCH") {
      this.control(message);
      return;
    }

    const batchId = message.tags.batch;
    if (batchId !== undefined) {
      const batch = this.batches.get(batchId);
      if (!batch || batch.poisoned) return; // orphan line for an unknown or dropped batch
      batch.items.push({ kind: "line", message });
      batch.bytes += line.length + 2;
      batch.lines += 1;
      if (batch.bytes > this.opts.maxBatchBytes) this.poison(batch, "batch-too-large");
      else if (batch.lines > this.opts.maxBatchLines) this.poison(batch, "batch-too-many-lines");
      return;
    }

    this.opts.onLine(message);
  }

  private control(message: IrcMessage): void {
    const ref = message.params[0] ?? "";
    if (!ref) return;
    const id = ref.slice(1);
    if (!id) return;

    if (ref.startsWith("-")) {
      this.close(id);
      return;
    }
    if (!ref.startsWith("+")) return;

    const type = message.params[1] ?? "";
    if (!type) {
      this.opts.onDrop?.(id, "batch-missing-type");
      return;
    }
    const parentId = message.tags.batch;
    const parent = parentId ? this.batches.get(parentId) : undefined;
    if (parentId && !parent) return; // nested under something we already dropped
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.opts.maxNesting) {
      this.opts.onDrop?.(id, "batch-nesting-too-deep");
      return;
    }
    if (this.batches.size >= this.opts.maxOpenBatches) {
      this.opts.onDrop?.(id, "too-many-open-batches");
      return;
    }

    const batch: OpenBatch = {
      id,
      type,
      params: message.params.slice(2),
      tags: message.tags,
      parentId,
      depth,
      items: [],
      bytes: message.params.join(" ").length + 2,
      lines: 0,
    };
    this.batches.set(id, batch);
    if (parent) parent.items.push({ kind: "batch", id });
  }

  private close(id: string): void {
    const batch = this.batches.get(id);
    if (!batch) return;
    this.batches.delete(id);
    if (batch.poisoned) {
      this.opts.onDrop?.(id, batch.poisoned);
      return;
    }
    const complete: IrcBatch = {
      id: batch.id,
      type: batch.type,
      params: batch.params,
      tags: batch.tags,
      items: batch.items,
      complete: true,
    };
    if (!batch.parentId) {
      this.opts.onBatch(complete);
      return;
    }
    const parent = this.batches.get(batch.parentId);
    if (!parent) return;
    for (const item of parent.items) {
      if (item.kind === "batch" && item.id === id) {
        item.batch = complete;
        return;
      }
    }
  }

  private poison(batch: OpenBatch, reason: string): void {
    if (!batch.poisoned) batch.poisoned = reason;
  }
}

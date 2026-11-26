import { type Draft, type Message, type QueueText } from "@client/model.ts";
import { randomId } from "@client/protocol.ts";

export function queuedTextFor(conversationId: string, account: string, snapshot: ComposerSnapshot, id: string, createdAt: number, mediaRevision?: string, editOf?: string, replyTo?: string, broadcast?: boolean): QueueText {
  const message: Message = {
    id, conversationId, authorAccount: account, authorNick: account, text: snapshot.text,
    time: new Date(createdAt).toISOString(), state: "saving", clientId: id, ...(replyTo ? { replyTo } : {}), ...(broadcast ? { broadcast: true } : {}),
  };
  return {
    message,
    operation: { id, messageId: id, conversationId, kind: "text", text: snapshot.text, state: "queued", createdAt, ...(editOf ? { editOf } : {}), ...(replyTo ? { replyTo } : {}), ...(broadcast ? { broadcast: true } : {}) },
    draftRevision: snapshot.revision,
    ...(mediaRevision ? { mediaRevision } : {}),
    ...(editOf ? { editOf } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(broadcast ? { broadcast: true } : {}),
  };
}

export interface DraftWriter {
  put(draft: Draft): Promise<void>;
  delete?(conversationId: string): Promise<void>;
}

export interface ComposerSnapshot {
  text: string;
  revision: string;
}

export class Composer {
  text = "";
  revision: string | null = null;
  onNote?: (note: string) => void;
  private tail: Promise<void> = Promise.resolve();
  private busy = false;
  // Late storage reads must not overwrite edits, even after a send clears the text.
  private pristine = true;

  constructor(
    private readonly conversationId: string,
    private readonly writer: DraftWriter,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomId,
  ) {}

  get committing(): boolean {
    return this.busy;
  }

  /** Adopt a persisted draft without writing it back. */
  load(draft: Draft | undefined): void {
    if (!draft || draft.conversationId !== this.conversationId || !this.pristine) return;
    this.text = draft.text;
    this.revision = draft.revision;
    this.pristine = false;
  }

  /** Queue deletion behind pending writes; a later edit remains queued after deletion. */
  discard(): Promise<boolean> {
    const revision = this.revision;
    const text = this.text;
    const task = this.tail.then(async () => {
      if (this.revision !== revision || this.text !== text) return false;
      await this.writer.delete?.(this.conversationId);
      if (this.revision !== revision || this.text !== text) return false;
      this.text = "";
      this.revision = null;
      this.pristine = false;
      return true;
    });
    this.tail = task.then(() => {}, () => {});
    return task;
  }

  /** Capture an edit synchronously, then serialize its write behind earlier edits. */
  edit(text: string): void {
    this.text = text;
    const revision = this.newId();
    this.revision = revision;
    this.pristine = false;
    this.tail = this.tail.then(async () => {
      try {
        await this.writer.put({ conversationId: this.conversationId, revision, text, updatedAt: this.now() });
        this.onNote?.("");
      } catch {
        this.onNote?.("Draft not saved");
      }
    });
  }

  /** Snapshot the current composer before any await. Null when there is nothing to send. */
  snapshot(): ComposerSnapshot | null {
    if (!this.text.trim()) return null;
    return { text: this.text, revision: this.revision ?? this.newId() };
  }

  /**
   * Persist the captured draft, run `send` with that exact snapshot, and clear the composer only
   * when the user has not typed newer text in the meantime. A newer edit and its draft survive;
   * this method never reads or deletes a revision it did not capture.
   */
  async commit(send: (snapshot: ComposerSnapshot) => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    const snapshot = this.snapshot();
    if (!snapshot) return false;
    this.busy = true;
    const captured = this.tail; // the write for the captured text, resolved before any await
    try {
      await captured;
      await send(snapshot);
      if (this.text === snapshot.text && this.revision === snapshot.revision) {
        this.text = "";
        this.revision = null;
      }
      return true;
    } finally {
      this.busy = false;
    }
  }
}

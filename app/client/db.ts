// Account-scoped Dexie database: the device's durable projection of Ergo.
// One database per (instance origin, account id) scope, so one account's cache can never be
// hydrated into another. No migration from the older instant cache yet; see the note at the
// bottom of this file and the honest migration gap recorded in .plans/slirc2.md.
import Dexie, { type Table } from "dexie";
import {
  clearsDraft,
  foldIdentifier,
  reactionEventWins,
  scopeKey,
  type AccountScope,
  type CompleteBatch,
  type Conversation,
  type Draft,
  type DurableTransactions,
  type MediaDraft,
  type Message,
  type Operation,
  type QueueText,
  type Reaction,
  type SyncProgress,
  type Tombstone,
} from "./model.ts";

// Last read server time per conversation on this device; Ergo's MARKREAD moves it across devices.
export interface ReadMarker {
  conversationId: string;
  time: string;
}

export type ReactionKey = [string, string, string, string];
export type TombstoneKey = [string, string];

const SEND_STATES = new Set(["saving", "queued", "sending", "uncertain", "confirmed", "failed"]);

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} required`);
  return value;
}

function assertBatch(batch: CompleteBatch): void {
  if (!batch || typeof batch !== "object") throw new Error("CompleteBatch required");
  if (batch.complete !== true) throw new Error("Incomplete batch rejected");
  required(batch.conversationId, "batch.conversationId");
  if (!Array.isArray(batch.events)) throw new Error("batch.events required");
  if (batch.events.length === 0) {
    if (batch.checkpoint) throw new Error("An empty batch cannot advance progress");
    return;
  }
  for (const event of batch.events) {
    if (!event || typeof event !== "object") throw new Error("Invalid protocol event");
    if (event.type === "message") {
      required(event.message?.id, "message.id");
      if (event.message.conversationId !== batch.conversationId) {
        throw new Error("Batch event belongs to another conversation");
      }
      required(event.message.authorAccount, "message.authorAccount");
      required(event.message.time, "message.time");
      if (typeof event.message.text !== "string") throw new Error("message.text must be a string");
      if (event.message.replyTo !== undefined && !/^[a-z0-9_-]{1,512}$/i.test(event.message.replyTo)) throw new Error("Invalid message reply target");
      if (!SEND_STATES.has(event.message.state)) throw new Error(`Invalid message state: ${event.message.state}`);
    } else if (event.type === "reaction") {
      if (event.reaction?.conversationId !== batch.conversationId) {
        throw new Error("Batch event belongs to another conversation");
      }
      required(event.reaction.messageServerId, "reaction.messageServerId");
      required(event.reaction.account, "reaction.account");
      required(event.reaction.emoji, "reaction.emoji");
    } else if (event.type === "redaction") {
      if (event.conversationId !== batch.conversationId) {
        throw new Error("Batch event belongs to another conversation");
      }
      required(event.serverId, "redaction.serverId");
    } else {
      throw new Error("Unknown protocol event");
    }
  }
  if (batch.checkpoint) {
    if (batch.checkpoint.conversationId !== batch.conversationId) {
      throw new Error("Checkpoint belongs to another conversation");
    }
    required(batch.checkpoint.serverId, "checkpoint.serverId");
    required(batch.checkpoint.time, "checkpoint.time");
    if (!Number.isFinite(Date.parse(batch.checkpoint.time)) || !batch.events.some((event) => {
      const position = event.position ?? (event.type === "message" ? event.message : undefined);
      return position?.serverId === batch.checkpoint!.serverId && position?.time === batch.checkpoint!.time;
    })) throw new Error("Checkpoint must identify an applied server event");
  }
}

export class ClientDatabase extends Dexie implements DurableTransactions {
  readonly scope: AccountScope;
  readonly conversations!: Table<Conversation, string>;
  readonly messages!: Table<Message, string>;
  readonly operations!: Table<Operation, string>;
  readonly drafts!: Table<Draft, string>;
  readonly mediaDrafts!: Table<MediaDraft, string>;
  readonly progress!: Table<SyncProgress, string>;
  readonly reactions!: Table<Reaction, ReactionKey>;
  readonly tombstones!: Table<Tombstone, TombstoneKey>;
  readonly readMarkers!: Table<ReadMarker, string>;

  constructor(scope: AccountScope) {
    const key = scopeKey(scope); // throws before Dexie is constructed on an invalid scope
    super(`slirc2-${key}`);
    this.scope = scope;
    this.version(1).stores({
      conversations: "id, parentId",
      // Latest confirmed history is read via [conversationId+time]; a server msgid is unique
      // inside one conversation, and undefined serverIds are not indexed by Dexie at all.
      messages: "id, conversationId, [conversationId+time], &[conversationId+serverId], [conversationId+clientId]",
      operations: "id, messageId, conversationId",
      drafts: "conversationId",
      progress: "conversationId",
      reactions: "[conversationId+messageServerId+account+emoji]",
      tombstones: "[conversationId+serverId]",
    });
    // Staged photo bytes per conversation. Additive: the v1 tables are inherited untouched.
    this.version(2).stores({ mediaDrafts: "conversationId" });
    // Read markers for unread counts. Additive like v2.
    this.version(3).stores({ readMarkers: "conversationId" });
  }

  // Forward only: a late or replayed marker can never resurrect counts the reader already cleared.
  async advanceReadMarker(conversationId: string, time: string): Promise<boolean> {
    required(conversationId, "conversationId");
    if (!Number.isFinite(Date.parse(time))) throw new Error("Read marker time must be a timestamp");
    return this.transaction("rw", this.readMarkers, async () => {
      const previous = await this.readMarkers.get(conversationId);
      if (previous && Date.parse(previous.time) >= Date.parse(time)) return false;
      await this.readMarkers.put({ conversationId, time });
      return true;
    });
  }

  // IRC account tags are case-mapped, so every comparison folds both sides with the scope's
  // negotiated mapping instead of trusting raw bytes or display nick casing.
  private sameAccount(a: string, b: string): boolean {
    return foldIdentifier(a, this.scope.caseMapping) === foldIdentifier(b, this.scope.caseMapping);
  }

  // Validate the exact shapes the transaction writes, before any write happens. A mismatch is an
  // input bug, not something to persist and reconcile later.
  private assertQueueText(send: QueueText): void {
    if (!send || typeof send !== "object") throw new Error("QueueText required");
    const { message, operation } = send;
    required(message?.id, "message.id");
    required(message?.conversationId, "message.conversationId");
    required(message?.authorAccount, "message.authorAccount");
    required(message?.time, "message.time");
    if (typeof message.text !== "string") throw new Error("message.text must be a string");
    if (!SEND_STATES.has(message.state)) throw new Error(`Invalid message state: ${message.state}`);
    // A queued send is always the authenticated account's own; never queue on someone's behalf.
    if (!this.sameAccount(message.authorAccount, this.scope.account)) {
      throw new Error("Queued message author must be the authenticated account");
    }
    required(send.draftRevision, "draftRevision");
    required(operation?.id, "operation.id");
    required(operation?.messageId, "operation.messageId");
    if (operation.messageId !== message.id) throw new Error("Operation must target its message");
    if (operation.conversationId !== message.conversationId) {
      throw new Error("Operation and message must share a conversation");
    }
    if (operation.kind !== "text") throw new Error("Only text operations are durable here");
    if (operation.text !== message.text) throw new Error("Operation and message text must agree");
    // queueText is the enqueue transaction; later send transitions belong to outbox.ts.
    if (operation.state !== "queued") throw new Error("queueText requires a queued operation");
    if (message.state !== "saving" && message.state !== "queued") {
      throw new Error("A queued send starts from saving or queued");
    }
    if (message.clientId !== undefined && message.clientId !== operation.id) {
      throw new Error("message.clientId must be the correlation id of its operation");
    }
    if (send.mediaRevision !== undefined && (typeof send.mediaRevision !== "string" || !send.mediaRevision.trim())) {
      throw new Error("mediaRevision must be a non-empty string");
    }
    if (send.editOf !== undefined && (typeof send.editOf !== "string" || !send.editOf.trim() || /[\u0000-\u0020\u007f]/.test(send.editOf))) {
      throw new Error("editOf must be a non-empty server msgid");
    }
    if (operation.editOf !== undefined && operation.editOf !== send.editOf) {
      throw new Error("operation.editOf must match the queued edit target");
    }
    if (send.replyTo !== undefined && !/^[a-z0-9_-]{1,512}$/i.test(send.replyTo)) throw new Error("replyTo must be a valid server msgid");
    if (message.replyTo !== send.replyTo || operation.replyTo !== send.replyTo) throw new Error("replyTo must match the queued message and operation");
    if (!Number.isFinite(operation.createdAt)) throw new Error("operation.createdAt required");
  }

  // Message + operation + matching draft deletion, all or none. The transaction callback must
  // stay synchronous with respect to the network: no fetch and no callback that leaves Dexie's
  // zone may run here. A throw aborts every write, including the draft delete.
  async queueText(send: QueueText): Promise<void> {
    await this.queueTexts([send]);
  }

  // Several sends commit together, in order: a photo set split into one message per photo is
  // queued whole or not at all.
  async queueTexts(sends: readonly QueueText[]): Promise<void> {
    for (const send of sends) this.assertQueueText(send);
    await this.transaction("rw", this.messages, this.operations, this.drafts, this.mediaDrafts, async () => {
      for (const send of sends) await this.addQueuedText(send);
    });
  }

  private async addQueuedText(send: QueueText): Promise<void> {
    const { message, operation } = send;
    // add, never put: an existing local row or operation is a refused write, not a silent
    // downgrade of a confirmed/sending row back to queued.
    // A queued edit already sits in its original's place, so it never flashes at the bottom.
    const old = send.editOf ? await this.messages.where("[conversationId+serverId]").equals([message.conversationId, send.editOf]).first() : undefined;
    const place = send.editOf
      ? { replaces: send.editOf, ...(old ? { at: old.at ?? old.time, chain: [...(old.chain ?? []), send.editOf] } : {}) }
      : {};
    await this.messages.add({ ...message, ...place, state: operation.state, clientId: operation.id });
    await this.operations.add({ ...operation });
    const draft = await this.drafts.get(message.conversationId);
    // Only the revision this send was built from may be cleared; a newer edit survives.
    if (clearsDraft(draft, send)) await this.drafts.delete(message.conversationId);
    // The staged media draft is consumed only when its revision matches the captured one. A
    // newer photo staged while this send was in flight is left for that send.
    if (send.mediaRevision) {
      const media = await this.mediaDrafts.get(message.conversationId);
      if (media && media.revision === send.mediaRevision) await this.mediaDrafts.delete(message.conversationId);
    }
  }

  private assertRedact(operation: Operation): void {
    required(operation?.id, "operation.id");
    if (operation.kind !== "redact" && operation.kind !== "admin-redact") throw new Error("queueRedact requires a redact operation");
    required(operation.conversationId, "operation.conversationId");
    required(operation.redactId, "operation.redactId");
    if (/[\u0000-\u0020\u007f]/.test(operation.redactId!)) throw new Error("redactId must be a server msgid");
    if (operation.state !== "queued") throw new Error("queueRedact requires a queued operation");
    if (!Number.isFinite(operation.createdAt)) throw new Error("operation.createdAt required");
  }

  // A redact op never removes the local message: it waits for the server's REDACT (live or a
  // confirmed own write) to tombstone the row, so a failed delete is still visible.
  async queueRedact(operation: Operation): Promise<void> {
    this.assertRedact(operation);
    await this.transaction("rw", this.operations, async () => {
      await this.operations.add({ ...operation });
    });
  }

  // Complete batches only: events and their checkpoint commit together, and an interrupted
  // batch can never move the checkpoint past records that were not applied.
  async applyBatch(batch: CompleteBatch): Promise<void> {
    assertBatch(batch);
    if (batch.events.length === 0 && !batch.window) return;
    await this.transaction("rw", this.messages, this.operations, this.reactions, this.progress, this.tombstones, async () => {
      if (batch.window) await this.pruneWindow(batch);
      for (const event of batch.events) {
        if (event.type === "message") await this.applyMessage(event.message);
        else if (event.type === "reaction") await this.applyReaction(event.reaction, event.remove);
        else await this.applyRedaction(event.conversationId, event.serverId);
      }
      if (batch.checkpoint) {
        const previous = await this.progress.get(batch.conversationId);
        if (!previous || Date.parse(batch.checkpoint.time) >= Date.parse(previous.time)) {
          await this.progress.put({ ...batch.checkpoint });
        }
      }
    });
  }

  // The server answered for this time window and these rows were not in its answer: they no longer
  // exist there. Only confirmed server rows go; a queued, sending, uncertain or failed local row has
  // no server copy to compare against and always stays. Same transaction as the page's events, so a
  // live line applied after the page cannot be removed by it.
  private async pruneWindow(batch: CompleteBatch): Promise<void> {
    const { after, before, keep = [] } = batch.window!;
    const lo = after === undefined ? -Infinity : Date.parse(after);
    const hi = before === undefined ? Infinity : Date.parse(before);
    if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error("Invalid history window");
    const present = new Set(keep);
    for (const event of batch.events) if (event.type === "message" && event.message.serverId) present.add(event.message.serverId);
    const gone = await this.messages.where("conversationId").equals(batch.conversationId).filter((row) => {
      if (row.state !== "confirmed" || !row.serverId || present.has(row.serverId)) return false;
      const time = Date.parse(row.time);
      return time > lo && time < hi;
    }).primaryKeys();
    if (gone.length) await this.messages.bulkDelete(gone);
  }

  // Duplicate server msgids and client correlation ids merge into one stable local row. The row
  // id never changes, and merge only happens inside the same conversation and for the same
  // case-mapped author account. A clientId merge is additionally limited to the authenticated
  // account's own optimistic row. Equal text alone is never a merge key.
  private async applyMessage(incoming: Message): Promise<void> {
    // A message deleted earlier (even before we ever saw its text) is not resurrected by a
    // delayed history replay. Ergo does not replay REDACT, so the tombstone is the only proof.
    const tombstone = incoming.serverId && await this.tombstones.get([incoming.conversationId, incoming.serverId]);
    const existing = await this.findDuplicate(incoming);
    if (!existing) {
      if (tombstone) return;
      // A new incoming id must not overwrite an unrelated row; reject the collision instead.
      if (await this.messages.get(incoming.id)) {
        throw new Error(`Message id collision in ${incoming.conversationId}: ${incoming.id}`);
      }
      await this.messages.add({ ...incoming });
      await this.applyEditAssociation(incoming, incoming.id);
      const confirmed = await this.confirmOwnOperation(incoming, incoming.id);
      if (confirmed?.editOf) await this.enqueueEditRedaction(incoming.conversationId, confirmed.editOf);
      return;
    }
    if (!this.sameAccount(existing.authorAccount, incoming.authorAccount)) {
      throw new Error(`Message conflict in ${incoming.conversationId}: ${incoming.serverId ?? incoming.clientId}`);
    }
    if (!existing.serverId && existing.clientId && existing.text !== incoming.text) {
      throw new Error("Correlation id does not match queued content");
    }
    // A tombstoned or already-deleted row must never regain content from a delayed history replay.
    const deleted = !!tombstone || existing.deleted || incoming.deleted;
    await this.messages.put({ ...existing, ...incoming, id: existing.id, text: deleted ? "" : incoming.text, deleted });
    await this.applyEditAssociation({ ...existing, ...incoming }, existing.id);
    const confirmed = await this.confirmOwnOperation(incoming, existing.id);
    if (confirmed?.editOf) await this.enqueueEditRedaction(incoming.conversationId, confirmed.editOf);
  }

  // Ergo persists `+draft/edit` in history but a live REDACT can be missed. Associating the
  // replacement with the replaced server msgid here makes the original stay hidden across a
  // reload instead of resurrecting from a later history page. Order-independent: a replacement
  // arriving before its original, and an original arriving after its replacement, both hide it.
  // The replacement also takes the original's place: `at` is the first original's time and
  // `chain` the server msgids it replaced, so an edit of an edit stays where the first one was.
  private async applyEditAssociation(incoming: Message, rowId: string): Promise<void> {
    if (incoming.replaces) {
      const old = await this.messages.where("[conversationId+serverId]").equals([incoming.conversationId, incoming.replaces]).first();
      if (old && this.sameAccount(old.authorAccount, incoming.authorAccount)) {
        await this.messages.put({ ...old, deleted: true });
        await this.anchorEdit(rowId, incoming.time, old.at ?? old.time, [...(old.chain ?? []), incoming.replaces]);
      }
    }
    if (incoming.serverId) {
      const replacement = await this.messages.where("conversationId").equals(incoming.conversationId)
        .filter((row) => row.replaces === incoming.serverId && this.sameAccount(row.authorAccount, incoming.authorAccount))
        .first();
      if (replacement) {
        const self = await this.messages.get(rowId);
        await this.messages.put({ ...incoming, ...(self?.at ? { at: self.at, chain: self.chain } : {}), id: rowId, deleted: true });
        // The original arrived after its replacement: move the replacement (and any edit of it) back.
        let at = self?.at ?? incoming.time;
        let chain = [...(self?.chain ?? []), incoming.serverId];
        let next: Message | undefined = replacement;
        for (let depth = 0; next && depth < 50; depth++) {
          if (!await this.anchorEdit(next.id, next.time, at, chain) || !next.serverId) break;
          const parent: string = next.serverId;
          chain = [...chain, parent];
          next = await this.messages.where("conversationId").equals(incoming.conversationId)
            .filter((row) => row.replaces === parent && this.sameAccount(row.authorAccount, incoming.authorAccount))
            .first();
        }
      }
    }
  }

  // An edit never moves later than itself; a bad clock or junk timestamp leaves it where it is.
  private async anchorEdit(rowId: string, time: string, at: string, chain: string[]): Promise<boolean> {
    const own = Date.parse(time);
    const anchor = Date.parse(at);
    if (!Number.isFinite(anchor) || (Number.isFinite(own) && anchor > own)) return false;
    await this.messages.update(rowId, { at, chain });
    return true;
  }

  // A confirmed echo of our own message must not leave a queued operation behind. The operation
  // is confirmed in the same transaction as the message row and the checkpoint. Returns the
  // confirmed operation so an edit can atomically queue its redaction.
  private async confirmOwnOperation(incoming: Message, rowId: string): Promise<Operation | undefined> {
    if (incoming.state !== "confirmed") return undefined;
    if (!this.sameAccount(incoming.authorAccount, this.scope.account)) return undefined;
    let operation: Operation | undefined;
    if (incoming.clientId) {
      const candidate = await this.operations.get(incoming.clientId);
      if (candidate && candidate.messageId === rowId) operation = candidate;
    }
    if (!operation) operation = await this.operations.where("messageId").equals(rowId).first();
    if (!operation) return undefined;
    await this.operations.put({ ...operation, state: "confirmed" });
    return operation;
  }

  // The replacement echo confirmed our edit: queue the original's REDACT in the SAME transaction,
  // so it exists durably before anyone could see the replacement without the cleanup. Deduped by
  // target; the outbox lock owner transmits it, any tab may enqueue.
  private async enqueueEditRedaction(conversationId: string, serverId: string): Promise<void> {
    const existing = await this.operations.where("conversationId").equals(conversationId)
      .filter((op) => op.kind === "redact" && op.redactId === serverId && op.state !== "failed")
      .first();
    if (existing) return;
    const id = globalThis.crypto?.randomUUID?.() ?? `redact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.operations.add({
      id, messageId: "", conversationId, kind: "redact", text: "", redactId: serverId, reason: "edited",
      state: "queued", createdAt: Date.now(),
    });
  }

  private async findDuplicate(incoming: Message): Promise<Message | undefined> {
    if (incoming.serverId) {
      const row = await this.messages
        .where("[conversationId+serverId]")
        .equals([incoming.conversationId, incoming.serverId])
        .first();
      if (row) return row;
    }
    // A client correlation id may only merge the authenticated account's own optimistic row.
    if (incoming.clientId && this.sameAccount(incoming.authorAccount, this.scope.account)) {
      const row = await this.messages
        .where("[conversationId+clientId]")
        .equals([incoming.conversationId, incoming.clientId])
        .filter((message) => this.sameAccount(message.authorAccount, this.scope.account) && !message.serverId)
        .first();
      if (row) return row;
    }
    return undefined;
  }

  private async applyReaction(reaction: Reaction, remove: boolean): Promise<void> {
    const key: ReactionKey = [reaction.conversationId, reaction.messageServerId, reaction.account, reaction.emoji];
    // A reconnect commonly replays history from the last checkpoint, which can deliver an older
    // react after a newer live unreact. The ordering comparison rejects that stale event instead
    // of resurrecting the reaction. Rows with no recorded ordering pass through (see the helper).
    const existing = await this.reactions.get(key);
    if (existing && !reactionEventWins(reaction.ordering, existing.ordering)) return;
    // Keep the row (active:false) instead of deleting: the last ordering is the only proof a later
    // replay is stale. The projection counts active rows only.
    await this.reactions.put({ ...reaction, active: !remove });
  }

  // Keep a tombstone whether or not the message is present yet. An early redaction is durable
  // evidence, and delayed history for that serverId is dropped by applyMessage. A live REDACT also
  // settles any matching queued/sending/uncertain redact operation.
  private async applyRedaction(conversationId: string, serverId: string): Promise<void> {
    await this.tombstones.put({ conversationId, serverId });
    const row = await this.messages
      .where("[conversationId+serverId]")
      .equals([conversationId, serverId])
      .first();
    // Delete is content removal, not a flag: drop the text/media reference from IndexedDB and
    // keep only the non-content row identity. The tombstone above is the resurrection guard.
    if (row) await this.messages.put({ ...row, text: "", deleted: true });
    const pending = await this.operations.where("conversationId").equals(conversationId)
      .filter((op) => (op.kind === "redact" || op.kind === "admin-redact") && op.redactId === serverId && op.state !== "confirmed")
      .toArray();
    for (const op of pending) await this.operations.put({ ...op, state: "confirmed" });
  }
}

// ponytail: no legacy-cache import. Migration from the instant branch's store.js schema is a
// separate reviewed task (stage 5); this database starts empty and does not read old rows.

// Boot failure-path regressions (B4/B5) for the client core: a queued send survives a
// reload and moves only after recovery, and an interrupted send stays uncertain until the user
// consents to a duplicate-risk resend. One file per process, fake-indexeddb before Dexie loads.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import {
  conversationId,
  type AccountScope,
  type Message,
  type Operation,
  type QueueText,
} from "../client/model.ts";

const { ClientDatabase } = await import("../client/db.ts");
const { createOutbox } = await import("../client/outbox.ts");
import type { Outbox, OutboxLockManager } from "../client/outbox.ts";

const scope: AccountScope = { instance: "https://slirc.test", accountId: "acct-lifecycle", account: "alice" };
const room = conversationId("room", "#lifecycle");

const databases: ClientDatabase[] = [];
const boxes: Outbox[] = [];

function openDatabase(): ClientDatabase {
  const db = new ClientDatabase(scope);
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const box of boxes.splice(0)) box.stop();
  for (const db of databases.splice(0)) await db.delete();
});

function queuedSend(id = `op-${Math.random().toString(36).slice(2)}`): QueueText {
  const message: Message = {
    id,
    conversationId: room,
    authorAccount: "alice",
    authorNick: "alice",
    text: "queued copy",
    time: new Date(1_700_000_000_000).toISOString(),
    state: "saving",
    clientId: id,
  };
  return {
    message,
    operation: { id, messageId: id, conversationId: room, kind: "text", text: message.text, state: "queued", createdAt: 1_700_000_000_000 },
    draftRevision: "rev-1",
  };
}

function fakeLocks(): OutboxLockManager {
  let held = false;
  const waiters: Array<() => void> = [];
  return {
    request(_name, _options, callback) {
      return new Promise<void>((resolve) => {
        const run = () => {
          held = true;
          void Promise.resolve()
            .then(callback)
            .finally(() => {
              held = false;
              const next = waiters.shift();
              if (next) next();
              resolve();
            });
        };
        if (held) waiters.push(run);
        else run();
      });
    },
  };
}

function makeOutbox(
  db: ClientDatabase,
  sent: string[],
  isReady: () => boolean,
  sendText: (operation: Operation) => Promise<void> = async (operation) => { sent.push(operation.id); },
): Outbox {
  const box = createOutbox({ db, transport: { sendText }, isReady, locks: fakeLocks(), BroadcastChannelImpl: null });
  boxes.push(box);
  return box;
}

test("queued work survives a reload and transmits exactly once only after readiness", async () => {
  // Before the reload: enqueued durably, never transmitted while unready.
  const firstDb = openDatabase();
  const sent: string[] = [];
  let ready = false;
  const first = makeOutbox(firstDb, sent, () => ready);
  await first.start();
  const send = queuedSend("op-reload");
  await first.enqueueText(send);
  await first.flush();
  expect(sent).toEqual([]);
  expect(await firstDb.operations.get(send.operation.id)).toMatchObject({ state: "queued" });

  // Reload: the sender and database go away; the committed rows must not.
  first.stop();
  firstDb.close();

  const secondDb = openDatabase();
  const second = makeOutbox(secondDb, sent, () => ready);
  await second.start();
  expect(await secondDb.messages.get(send.message.id)).toMatchObject({ state: "queued", text: "queued copy" });

  // Reconnect but recovery (history reconciliation) is not complete: still no transmission.
  await second.notifyReady();
  await second.flush();
  expect(sent).toEqual([]);

  // Recovery complete: exactly one wire write, and later flushes never repeat it.
  ready = true;
  await second.notifyReady();
  await second.notifyReady();
  await second.flush();
  expect(sent).toEqual([send.operation.id]);
});

test("an interrupted send recovers uncertain and cannot be retried without consent", async () => {
  const db = openDatabase();
  const send = queuedSend("op-uncertain");
  await db.queueText(send);
  // Interruption after the pre-network `sending` commit and before any acknowledgement: the wire
  // write may have happened, so the persisted state at reload is `sending`.
  await db.transaction("rw", db.operations, db.messages, async () => {
    await db.operations.put({ ...send.operation, state: "sending" });
    await db.messages.put({ ...send.message, state: "sending", clientId: send.operation.id });
  });
  db.close();

  // Reload over the same durable rows: a persisted in-flight op recovers as uncertain and is
  // never replayed, whatever the outbox is told about readiness.
  const reopened = openDatabase();
  const retrySent: string[] = [];
  const ready = true;
  const second = makeOutbox(reopened, retrySent, () => ready);
  await second.start();
  expect(await reopened.operations.get(send.operation.id)).toMatchObject({ state: "uncertain" });
  await second.notifyReady();
  await second.flush();
  await second.notifyReady();
  await second.flush();
  expect(retrySent).toEqual([]); // no automatic retry, ever

  // Only explicit duplicate-risk consent revives it, and then exactly once.
  await expect(second.resendUncertain(send.operation.id, { duplicateRiskAccepted: false })).rejects.toThrow(/consent/);
  expect(retrySent).toEqual([]);
  await second.resendUncertain(send.operation.id, { duplicateRiskAccepted: true });
  await second.flush();
  expect(retrySent).toEqual([send.operation.id]);
});

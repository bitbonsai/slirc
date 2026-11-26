// Notes: one private scratchpad per account. Every query is keyed by the owner's immutable account
// id, so a guessed note id from another account reads, edits and deletes nothing.
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";

export const NOTE_MAX = 4_000;

export type Note = { id: string; body: string; createdAt: number; updatedAt: number };

const row = (value: any): Note => ({ id: value.id, body: value.body, createdAt: value.created_at, updatedAt: value.updated_at });

/** The trimmed body, or null when it is empty, too long or not text. */
export function noteBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = value.replace(/\r\n?/g, "\n").trim();
  return body && body.length <= NOTE_MAX && !/[\x00-\x08\x0b-\x1f\x7f]/.test(body) ? body : null;
}

export function listNotes(accountId: string): Note[] {
  return (db.query("SELECT * FROM notes WHERE account_id = ? ORDER BY created_at, rowid").all(accountId) as any[]).map(row);
}

export function addNote(accountId: string, body: string, now = Date.now()): Note {
  const id = randomBytes(9).toString("base64url");
  db.query("INSERT INTO notes (id, account_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, accountId, body, now, now);
  return { id, body, createdAt: now, updatedAt: now };
}

export function editNote(accountId: string, id: string, body: string, now = Date.now()): Note | null {
  const changed = db.query("UPDATE notes SET body = ?, updated_at = ? WHERE id = ? AND account_id = ?").run(body, now, id, accountId).changes;
  return changed ? row(db.query("SELECT * FROM notes WHERE id = ? AND account_id = ?").get(id, accountId)) : null;
}

export function deleteNote(accountId: string, id: string): boolean {
  return db.query("DELETE FROM notes WHERE id = ? AND account_id = ?").run(id, accountId).changes > 0;
}

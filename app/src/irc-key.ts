import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

// IRC passwords are never stored. Each one is HMAC(key, account id + counter), so a copy of
// chat.sqlite holds ids and counters, useless without this key. The key is 32 random bytes in a
// file mounted read-only from outside the backed-up config folder (see deploy/README.md).
// `bun test` runs without a key file and gets a fixed one; every other process refuses to start.
export const IRC_KEY_FILE_DEFAULT = "/run/slirc-irc-key";
let key: Buffer | null = null;

export function ircKey(): Buffer {
  if (key) return key;
  const file = process.env.SLIRC_IRC_KEY_FILE || IRC_KEY_FILE_DEFAULT;
  let raw: Buffer | null = null;
  try { raw = readFileSync(file); } catch {}
  if (raw && raw.length >= 32) return key = raw;
  if (process.env.NODE_ENV === "test" && !raw) return key = createHash("sha256").update("slirc-test-irc-key").digest();
  throw new Error(raw ? `IRC key in ${file} is shorter than 32 bytes` : `IRC key file ${file} is missing; create it with: openssl rand -out <file> 32`);
}

export function ircPasswordFor(accountId: string, gen: number): string {
  if (!accountId || !Number.isInteger(gen) || gen < 0) throw new Error("IRC password needs an account id and a counter");
  return createHmac("sha256", ircKey()).update(`slirc-irc-v1\0${accountId}\0${gen}`).digest("base64url");
}

// An accounts row's current password. A NULL counter is a row inserted without one: counter 0.
export function accountIrcPassword(row: { account_id: string; irc_password_gen: number | null }): string {
  return ircPasswordFor(row.account_id, row.irc_password_gen ?? 0);
}

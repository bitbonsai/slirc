import { db } from "../db.ts";

let ircDeviceChanges = Promise.resolve();

export function serializeIrcDeviceChange<T>(work: () => Promise<T>): Promise<T> {
  // ponytail: one queue fits one app process; use a distributed lock if Slirc scales out.
  const change = ircDeviceChanges.then(work);
  ircDeviceChanges = change.then(() => {}, () => {});
  return change;
}

// The note people got from the derived-password migration (deploy A): their plain IRC
// clients, or the managed bots they own, need the new password. Bits of accounts.irc_reset_notice.
export const IRC_RESET_CLIENTS = 1;

export const IRC_RESET_BOTS = 2;

export const ircResetNotice = (bits: number) => ({ clients: !!(bits & IRC_RESET_CLIENTS), bots: !!(bits & IRC_RESET_BOTS) });

export function clearIrcResetNotice(nick: string, bit: number): void {
  db.query("UPDATE accounts SET irc_reset_notice = irc_reset_notice & ~? WHERE nick = ? COLLATE NOCASE").run(bit, nick);
}

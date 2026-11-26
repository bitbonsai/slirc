// Boot check: the IRC key is there, stored passwords are migrated, the owner and oper IRC accounts
// exist and the oper can sign in. This once also moved the founder's first nick to OWNER_NICK. That
// rename finished long ago, and keeping it meant any later account with that nick was merged into
// the owner on every start.
// A database that skipped deploy A still holds stored passwords, and db.ts refuses to load it unless
// this flag is set. Imports are dynamic so the flag is in place before db.ts runs, and accounts.ts
// loads only after the migration.
export {};
process.env.SLIRC_IRC_MIGRATION = "1";
const { ircKey } = await import("./irc-key.ts");
const { dropStoredIrcPasswords, hasStoredIrcPasswordColumns } = await import("./db.ts");
const { migrateIrcPasswords } = await import("./irc-migration.ts");

// No key, no start: every IRC password derives from it.
ircKey();
// Stored passwords move to derived ones before anything signs in with them. Production ran deploy A,
// so the columns are gone and this does nothing. A row Ergo refused keeps its stored password and
// the boot loop retries.
if (hasStoredIrcPasswordColumns()) {
  await migrateIrcPasswords();
  const left = dropStoredIrcPasswords();
  if (left) throw new Error(`${left} rows still hold a stored IRC password after the migration; see the errors above`);
}
// accounts.ts writes the owner row on import, which needs the stored-password column gone.
const { ensureOperIrcAccount, ensureOwnerIrcAccount } = await import("./accounts.ts");
const { ergoOperUser } = await import("./config.ts");
const { operClient } = await import("./grants.ts");
await ensureOwnerIrcAccount();
await ensureOperIrcAccount();
const client = await operClient();
console.log(`connected as IRC oper ${ergoOperUser()}`);
client.quit();

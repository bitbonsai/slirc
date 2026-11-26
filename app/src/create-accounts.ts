// One-shot bootstrap: create IRC accounts while registration is closed.
// Env: ACCOUNTS="nick:pass,nick:pass"

import { operClient, serviceCommand } from "./grants.ts";

const accounts = (process.env.ACCOUNTS || "").split(",").filter(Boolean);
if (accounts.length === 0) throw new Error("ACCOUNTS required (nick:pass,...)");

const client = await operClient();
try {
  let registered = 0;
  for (const account of accounts) {
    const [nick, pass] = account.split(":");
    if (!nick || !pass) continue;
    await serviceCommand(client, "NickServ", `SAREGISTER ${nick} ${pass}`, /Successfully registered account|Account already exists/i);
    registered++;
  }
  console.log(`registered ${registered} account(s)`);
} finally {
  client.quit();
}

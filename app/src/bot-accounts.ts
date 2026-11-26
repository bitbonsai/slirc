import { randomBytes } from "node:crypto";
import { accountByNick, accountNick, ergo } from "./accounts.ts";
import { db } from "./db.ts";
import { ircPasswordFor } from "./irc-key.ts";
import { ergoOperUser } from "./config.ts";

export class BotError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Instance services and first-party helpers are not user bots.
const RESERVED = new Set(["slirc", ergoOperUser().toLowerCase(), "pushbot", "nickserv", "chanserv", "histserv", "operserv", "remind", "help", "poll", "updates"]);

export function botLimit(): number {
  const configured = Number(process.env.BOT_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}

export function botCount(owner: string): number {
  const row = db.query("SELECT COUNT(*) AS count FROM accounts WHERE kind = 'bot' AND owner IS NOT NULL AND owner = ? COLLATE NOCASE").get(owner) as { count: number } | null;
  return row?.count || 0;
}

// ponytail: `deploy` when free, otherwise `deploy-bitbonsai`, so two people can both run a bot called `deploy`.
function nickCandidates(name: string, owner: string): string[] {
  const base = accountNick(name);
  const suffix = accountNick(owner);
  const qualified = `${base.slice(0, Math.max(2, 19 - suffix.length))}-${suffix}`;
  return qualified === base ? [base] : [base, qualified];
}

// Admin-only bot provisioning. The owner nick is resolved through the trusted account
// table inside the helper, so callers cannot pass a forged role: the gate fires
// before any Ergo saregister or DB write.
export async function createBotAccount(ownerNick: string, name: string): Promise<{ nick: string; password: string }> {
  const owner = accountByNick(ownerNick);
  if (!owner || owner.kind !== "human" || !owner.verifiedAt || owner.role !== "admin") throw new BotError("admin required", 403);
  if (!name.trim()) throw new BotError("Choose a name for the bot.", 400);
  if (!/[a-z0-9]/i.test(name)) throw new BotError("Use letters or numbers in the bot name.", 400);
  const options = nickCandidates(name, owner.nick);
  if (options.some((nick) => RESERVED.has(nick))) throw new BotError("That name is reserved.", 400);
  if (botCount(owner.nick) >= botLimit()) throw new BotError(`Bot limit reached (${botLimit()}). Remove one to add another.`, 409);

  // The id comes first so Ergo gets the password the new row derives. Shown once, never stored.
  const accountId = randomBytes(16).toString("hex");
  const password = ircPasswordFor(accountId, 0);
  for (const nick of options) {
    if (accountByNick(nick)) continue;
    const registered = await ergo("/v1/ns/saregister", { accountName: nick, passphrase: password });
    if (!registered.success) {
      if (registered.errorCode === "ACCOUNT_EXISTS") continue;
      throw new BotError(registered.error || "Could not create bot account.", 500);
    }
    const now = Date.now();
    db.query(`INSERT INTO accounts (nick, email, irc_password_gen, account_id, role, kind, owner, verified_at, provisional_expires_at, created_at)
              VALUES (?, ?, 0, ?, 'member', 'bot', ?, ?, NULL, ?)`)
      .run(nick, `${nick}@bots.invalid`, accountId, owner.nick, now, now);
    return { nick, password };
  }
  throw new BotError("That name is already in use.", 409);
}

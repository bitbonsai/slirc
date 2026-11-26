import { accountByEmail, validEmail, type Account } from "./accounts.ts";
import { normalizeEmail, pendingEmailInvite, type InviteDestination } from "./email-invites.ts";
import { discoverableHuman, isMember } from "./rooms.ts";

// One admin pastes or uploads a list; the server sorts every row before anything is sent.
// A verified person is added directly, like /api/invites/email does. The row names them, or says
// they're already in the channel, only when the admin could already find them in People; anyone else
// is a plain "add" with no nick. Unverified, bot and agent accounts read as "new", like the
// single-invite flow.
export type BulkRowStatus = "invalid" | "duplicate" | "self" | "existing" | "add" | "pending" | "new";
export type BulkRow = { email: string; status: BulkRowStatus; nick?: string; account?: Account };

export const BULK_PREVIEW_MAX = 1000;
export const BULK_SEND_MAX = 25;

export function planBulkInvite(sender: Account, destination: Extract<InviteDestination, { channel: string }>, rawEmails: readonly unknown[]): BulkRow[] {
  const seen = new Set<string>();
  return rawEmails.map((raw): BulkRow => {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text || !validEmail(text)) return { email: text.slice(0, 254), status: "invalid" };
    const email = normalizeEmail(text);
    if (seen.has(email)) return { email, status: "duplicate" };
    seen.add(email);
    if (email === normalizeEmail(sender.email)) return { email, status: "self" };
    const match = accountByEmail(email);
    const verified = match?.kind === "human" && match.verifiedAt && match.id !== sender.id ? match : null;
    if (verified && !discoverableHuman(sender.nick, verified.id)) return { email, status: "add", account: verified };
    if (verified) return { email, status: isMember(verified.nick, destination.channel) ? "existing" : "add", nick: verified.nick, account: verified };
    if (pendingEmailInvite(sender.id, email, destination)) return { email, status: "pending" };
    return { email, status: "new" };
  });
}

// What the client sees: never the account row itself.
export const bulkRowView = (row: BulkRow) => ({ email: row.email, status: row.status, ...(row.nick ? { nick: row.nick } : {}) });

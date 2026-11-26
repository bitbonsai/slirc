import { verifiedHuman, currentUser } from "../http/session.ts";
import { knownAccount, accountDetails } from "../http/profiles.ts";
import { inactiveHelper } from "../config.ts";
import { accountByNick } from "../accounts.ts";
import { discoverableHuman, reopenDirectConversation, directConversation, closeDirectConversation, sharedContacts } from "../rooms.ts";
import { openDirectConversation } from "../direct.ts";
import { appError } from "../http/common.ts";
import { Hono } from "hono";

export const dms = new Hono();

dms.post("/api/dms/:nick", async (c) => {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const nick = requester.nick;
  const other = knownAccount(c.req.param("nick"));
  if (!other || other === nick || inactiveHelper(other)) return c.json({ error: "contact not found" }, 404);
  const otherAccount = accountByNick(other);
  // Same discovery gate as search and the accountId recipient path for humans; personal agents are
  // owner-scoped so a guessed nick cannot start a DM with someone else's. Admin-managed helper bots
  // keep their existing access. All checks run before any write.
  if (otherAccount?.kind === "human") {
    if (!discoverableHuman(nick, otherAccount.id)) return c.json({ error: "contact not found" }, 404);
  } else if (otherAccount?.kind === "agent") {
    if (!otherAccount.owner || otherAccount.owner.toLowerCase() !== nick.toLowerCase()) return c.json({ error: "contact not found" }, 404);
  }
  try {
    const direct = await openDirectConversation(nick, other);
    reopenDirectConversation(accountByNick(nick)!.id, direct.channel);
    return c.json(direct);
  } catch (error) {
    console.error(`direct channel failed for ${nick} and ${other}:`, error);
    return c.json({ error: directConversation(nick, other) ? "could not reopen direct message" : "could not start direct message" }, 500);
  }
});

// Old #t- threads are retired; reply threads need no channel.
dms.post("/api/dms/:nick/threads", (c) => c.json({ error: "threads are now replies inside the conversation" }, 410));

dms.delete("/api/dms/:nick", (c) => {
  const nick = currentUser(c);
  const other = c.req.param("nick").trim();
  const account = nick && accountByNick(nick);
  if (!account || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(other) || other.toLowerCase() === nick.toLowerCase()) return c.json({ error: "contact not found" }, 404);
  try {
    if (!closeDirectConversation(account.id, nick, other)) return c.json({ error: "direct message not found" }, 404);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not close direct message.");
  }
});

dms.get("/api/contacts", (c) => {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const nick = requester.nick;
  const contacts = sharedContacts(nick);
  return c.json({ contacts, accountDetails: accountDetails(contacts) });
});

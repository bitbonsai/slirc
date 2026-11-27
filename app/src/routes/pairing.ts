import { createLimiter } from "../request-security.ts";
import { bodyLimit } from "hono/body-limit";
import { appOrigin, userAgentDetails, verifiedHuman, session, currentUser, startSession, revokeSession, hash } from "../http/session.ts";
import { pairingIp, appError } from "../http/common.ts";
import { accountByEmail, accountByNick } from "../accounts.ts";
import { createRequest, PairingError, pendingForOwner, deliverOnce, findByCode, approve, deny } from "../pairing.ts";
import { publish } from "../live.ts";
import { mintOffer, cancelOffers, redeemOffer, redeemedSession } from "../pair-offers.ts";
import { db } from "../db.ts";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";

export const pairing = new Hono();

// browser-session pairing
const pairPollLimit = createLimiter({ limit: 60, windowMs: 60_000 });

const pairApprovalLimit = createLimiter({ limit: 30, windowMs: 60_000 });

pairing.use("/api/pair*", bodyLimit({ maxSize: 2_048 }));

pairing.use("/api/pair*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("Origin");
  if (c.req.method === "POST" && origin && origin !== appOrigin(c.req.header("Host"))) {
    return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  }
  return next();
});

// browser-session pairing
pairing.post("/api/pair", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid pairing request" }, 400);
  const ip = pairingIp(c);
  try {
    if (body.kind === "session") {
      const { browser, os } = userAgentDetails(c.req.header("User-Agent"));
      // The phone has the email typed by now; when it matches an account, only that account's
      // other browsers hear about the request, so nobody else gets asked to link a stranger.
      const known = typeof body.email === "string" && body.email ? accountByEmail(body.email) : null;
      const request = createRequest({ kind: "session", browser, os, ip, owner: known?.nick || "" });
      if (known) publish(known.nick, "pair-request", { code: request.code, browser, os, expiresAt: request.expiresAt });
      return c.json(request, 201);
    }
    // Agent pairing v1 (owner + machine + tool) is gone; agents redeem a connect code instead.
    return c.json({ error: "agent pairing moved to connect codes" }, 410);
  } catch (error) {
    if (error instanceof PairingError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// Phone pairing by QR (pair-offers.ts). A signed-in browser mints a one-time offer; the browser that
// redeems it is signed in as the same account with no confirmation, so these routes are strict:
// same Origin plus a header a form or no-cors fetch cannot send, and a limiter on each side.
const offerMintLimit = createLimiter({ limit: 60, windowMs: 60 * 60_000 });

// Every redeem attempt counts, failed or not, so guessing and replaying share one budget per peer.
const offerRedeemLimit = createLimiter({ limit: 20, windowMs: 10 * 60_000 });

const offerCsrf = (c: any) => {
  const origin = c.req.header("Origin");
  return !!origin && origin === appOrigin(c.req.header("Host")) && c.req.header("X-Slirc-Pair") === "1";
};

pairing.post("/api/pair/offer", (c) => {
  if (!offerCsrf(c)) return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  const account = verifiedHuman(c);
  const active = session(c);
  if (!account || !active) return c.json({ error: "not signed in" }, 401);
  if (!offerMintLimit.check(account.nick.toLowerCase())) return c.json({ error: "Too many codes. Try again later." }, 429);
  const offer = mintOffer(account.nick, active.tokenHash);
  // The token rides in the fragment, which browsers never send: it stays out of server, proxy and
  // CDN logs, and out of Referer.
  return c.json({ id: offer.id, url: `${appOrigin(c.req.header("Host"))}/pair#o=${offer.token}`, expiresAt: offer.expiresAt }, 201);
});

pairing.delete("/api/pair/offer", (c) => {
  if (!offerCsrf(c)) return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  const active = session(c);
  if (!active) return c.json({ error: "not signed in" }, 401);
  cancelOffers(active.tokenHash);
  return c.body(null, 204);
});

pairing.post("/api/pair/offer/redeem", async (c) => {
  if (!offerCsrf(c)) return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  if (!offerRedeemLimit.check(pairingIp(c))) return c.json({ error: "Too many attempts. Try again later." }, 429);
  // A browser that is already signed in keeps its session and the offer stays unspent. Otherwise a
  // pair link sent to someone could quietly switch their browser into the sender's account.
  if (currentUser(c)) return c.json({ signedIn: true, already: true });
  const body = await c.req.json().catch(() => null);
  const { browser, os } = userAgentDetails(c.req.header("User-Agent"));
  const redeemed = redeemOffer(body && typeof body === "object" ? (body as { token?: unknown }).token : null, { browser, os }, (nick) => startSession(c, nick));
  // browser and os come from a fixed vocabulary, never the raw User-Agent; the token is never logged.
  if (!redeemed) {
    console.log(`pair offer refused device=${browser}/${os}`);
    return c.json({ error: "That code is no longer valid. Show a new one and scan again." }, 400);
  }
  const account = accountByNick(redeemed.nick);
  console.log(`pair offer redeemed account=${redeemed.nick} device=${browser}/${os}`);
  publish(redeemed.nick, "pair-offer", { id: redeemed.id, browser, os });
  return c.json({ signedIn: true, accountId: account?.id, nick: redeemed.nick });
});

// "Not you? Sign it out" on the minting card: ends the one session that offer started.
pairing.delete("/api/pair/offer/:id/session", (c) => {
  if (!offerCsrf(c)) return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  const account = verifiedHuman(c);
  const active = session(c);
  if (!account || !active) return c.json({ error: "not signed in" }, 401);
  const target = redeemedSession(c.req.param("id"), active.tokenHash);
  if (!target || target.nick.toLowerCase() !== account.nick.toLowerCase()) return c.json({ error: "session not found" }, 404);
  if (!revokeSession(target.sessionHash, account.nick)) return c.json({ error: "session not found" }, 404);
  return c.body(null, 204);
});

// browser-session pairing
pairing.get("/api/pair/pending", (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  // Codes are shown as "123 456"; a pasted one may keep the space.
  const code = (c.req.query("code") || "").replace(/\D/g, "");
  if (code && !pairApprovalLimit.check(nick)) return c.json({ error: "too many pairing attempts" }, 429);
  return c.json(pendingForOwner(nick, code));
});

// browser-session pairing
pairing.get("/api/pair/:code", (c) => {
  const ip = pairingIp(c);
  if (!pairPollLimit.check(ip)) return c.json({ error: "too many pairing checks" }, 429);
  const result = deliverOnce(c.req.param("code"), c.req.header("X-Pair-Secret") || "");
  return result ? c.json(result) : c.json({ error: "pairing request not found" }, 404);
});

pairing.get("/api/pair/:code/session", (c) => {
  const tokenHash = hash(c.req.query("token") || "");
  const request = db.query("SELECT owner FROM pair_requests WHERE code = ? AND kind = 'session' AND status = 'delivered' AND expires_at > ?")
    .get(c.req.param("code"), Date.now()) as { owner: string } | null;
  const link = request && db.query("SELECT nick, expires_at FROM magic_links WHERE token_hash = ?").get(tokenHash) as { nick: string; expires_at: number } | null;
  if (!request || !link || link.expires_at <= Date.now() || link.nick.toLowerCase() !== request.owner.toLowerCase()) return c.json({ error: "login token not found" }, 404);
  db.transaction(() => {
    db.query("DELETE FROM magic_links WHERE token_hash = ?").run(tokenHash);
    db.query("DELETE FROM pair_requests WHERE code = ?").run(c.req.param("code"));
    startSession(c, request.owner);
  })();
  // Both clients serve the app at the root, so a completed device link never lands on a client path.
  return c.redirect("/", 302);
});

// browser-session pairing
pairing.post("/api/pair/:code/allow", async (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  if (!pairApprovalLimit.check(owner)) return c.json({ error: "too many pairing attempts" }, 429);
  const request = findByCode(c.req.param("code").replace(/\s/g, ""));
  if (!request || request.status !== "pending") return c.json({ error: "pairing request not found" }, 404);
  if (request.kind !== "session") return c.json({ error: "agent pairing moved to connect codes" }, 410);
  if (!verifiedHuman(c)) return c.json({ error: "verified account required" }, 403);
  if (request.owner && request.owner.toLowerCase() !== owner.toLowerCase()) return c.json({ error: "pairing request belongs to another owner" }, 403);
  const loginToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  try {
    db.transaction(() => {
      db.query("INSERT INTO magic_links (token_hash, nick, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(hash(loginToken), owner, now + 5 * 60_000, now);
      if (!approve(request.code, owner, loginToken)) throw new Error("pairing request expired");
    })();
    return c.json({ nick: owner });
  } catch (error) {
    return appError(c, error, "Could not link browser.");
  }
});

// browser-session pairing
pairing.post("/api/pair/:code/deny", (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  if (!pairApprovalLimit.check(owner)) return c.json({ error: "too many pairing attempts" }, 429);
  const request = findByCode(c.req.param("code").replace(/\s/g, ""));
  if (!request || request.status !== "pending") return c.json({ error: "pairing request not found" }, 404);
  if (request.kind !== "session") return c.json({ error: "agent pairing moved to connect codes" }, 410);
  if (request.owner && request.owner.toLowerCase() !== owner.toLowerCase()) return c.json({ error: "pairing request belongs to another owner" }, 403);
  deny(request.code, owner);
  return c.body(null, 204);
});

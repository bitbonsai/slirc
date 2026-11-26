import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const offers = await import("../src/pair-offers.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const minter = sha("minting-session");
const device = { browser: "Safari", os: "iOS" };
let started: string[] = [];
// Stands in for server.ts startSession: inserts the row and returns its hash.
const start = (nick: string) => {
  const sessionHash = sha(`phone-${started.length}`);
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(sessionHash, nick, Date.now());
  started.push(sessionHash);
  return sessionHash;
};
const pending = () => (db.query("SELECT COUNT(*) AS count FROM pair_offers WHERE status = 'pending'").get() as { count: number }).count;

beforeEach(() => {
  started = [];
  db.query("DELETE FROM pair_offers").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM accounts WHERE nick <> 'bitbonsai'").run();
  db.query("UPDATE accounts SET kind = 'human', verified_at = 1 WHERE nick = 'bitbonsai'").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(minter, Date.now());
});

describe("phone pairing offers", () => {
  test("a minted offer stores only the token hash and lives 60 seconds", () => {
    const offer = offers.mintOffer("bitbonsai", minter, 1_000);
    expect(offer.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(offer.token, "base64url").length).toBe(32);
    expect(offer.expiresAt).toBe(61_000);
    const row = db.query("SELECT * FROM pair_offers").get() as Record<string, unknown>;
    expect(row.token_hash).toBe(sha(offer.token));
    expect(JSON.stringify(row)).not.toContain(offer.token);
    expect(offer.id).not.toBe(offer.token);
  });

  test("redeeming starts one session for the minting account and records the device", () => {
    const offer = offers.mintOffer("bitbonsai", minter);
    const redeemed = offers.redeemOffer(offer.token, device, start);
    expect(redeemed).toEqual({ id: offer.id, nick: "bitbonsai", sessionHash: started[0]! });
    expect(db.query("SELECT status, browser, os, redeemed_session FROM pair_offers").get())
      .toEqual({ status: "used", browser: "Safari", os: "iOS", redeemed_session: started[0]! });
  });

  test("an offer cannot be redeemed twice", () => {
    const offer = offers.mintOffer("bitbonsai", minter);
    expect(offers.redeemOffer(offer.token, device, start)).not.toBeNull();
    expect(offers.redeemOffer(offer.token, device, start)).toBeNull();
    expect(started).toHaveLength(1);
  });

  test("concurrent redeems give exactly one session", async () => {
    const offer = offers.mintOffer("bitbonsai", minter);
    const results = await Promise.all(Array.from({ length: 8 }, async () => offers.redeemOffer(offer.token, device, start)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(started).toHaveLength(1);
  });

  test("an expired offer is dead at the 60 second mark", () => {
    const offer = offers.mintOffer("bitbonsai", minter, 1_000);
    expect(offers.redeemOffer(offer.token, device, start, 61_000)).toBeNull();
    expect(started).toHaveLength(0);
    const fresh = offers.mintOffer("bitbonsai", minter, 1_000);
    expect(offers.redeemOffer(fresh.token, device, start, 60_999)).not.toBeNull();
  });

  test("wrong, malformed and non-string tokens are refused without touching the offer", () => {
    const offer = offers.mintOffer("bitbonsai", minter);
    for (const bad of ["", "x", "A".repeat(43), offer.token + "A", offer.token.slice(1), `${offer.token}'--`, null, 7, { token: offer.token }, [offer.token]]) {
      expect(offers.redeemOffer(bad, device, start)).toBeNull();
    }
    expect(started).toHaveLength(0);
    expect(pending()).toBe(1);
  });

  test("minting again cancels that session's earlier offer only", () => {
    const other = sha("other-session");
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(other, Date.now());
    const first = offers.mintOffer("bitbonsai", minter);
    const elsewhere = offers.mintOffer("bitbonsai", other);
    const second = offers.mintOffer("bitbonsai", minter);
    expect(offers.redeemOffer(first.token, device, start)).toBeNull();
    expect(offers.redeemOffer(elsewhere.token, device, start)).not.toBeNull();
    expect(offers.redeemOffer(second.token, device, start)).not.toBeNull();
  });

  test("cancelling kills the pending offer", () => {
    const offer = offers.mintOffer("bitbonsai", minter);
    offers.cancelOffers(minter);
    expect(offers.redeemOffer(offer.token, device, start)).toBeNull();
    expect(pending()).toBe(0);
  });

  test("the offer dies with the minting session", () => {
    const offer = offers.mintOffer("bitbonsai", minter);
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(minter);
    expect(offers.redeemOffer(offer.token, device, start)).toBeNull();
    expect(started).toHaveLength(0);
    expect(pending()).toBe(0);
  });

  test("the offer dies when the account stops being a verified human", () => {
    for (const change of ["kind = 'agent'", "kind = 'bot'", "verified_at = NULL"]) {
      db.query("UPDATE accounts SET kind = 'human', verified_at = 1 WHERE nick = 'bitbonsai'").run();
      const offer = offers.mintOffer("bitbonsai", minter);
      db.query(`UPDATE accounts SET ${change} WHERE nick = 'bitbonsai'`).run();
      expect(offers.redeemOffer(offer.token, device, start)).toBeNull();
    }
    const offer = offers.mintOffer("bitbonsai", minter);
    db.query("DELETE FROM accounts WHERE nick = 'bitbonsai'").run();
    expect(offers.redeemOffer(offer.token, device, start)).toBeNull();
    expect(started).toHaveLength(0);
    db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('bitbonsai', 'owner@example.com', 'admin', 1, 1)").run();
  });

  test("only the minting session can look up the session its offer started", () => {
    const offer = offers.mintOffer("bitbonsai", minter);
    expect(offers.redeemedSession(offer.id, minter)).toBeNull();
    offers.redeemOffer(offer.token, device, start);
    expect(offers.redeemedSession(offer.id, minter)).toEqual({ nick: "bitbonsai", sessionHash: started[0]! });
    expect(offers.redeemedSession(offer.id, sha("other-session"))).toBeNull();
    expect(offers.redeemedSession("nope", minter)).toBeNull();
  });

  test("sweeping drops expired pending offers and old used ones", () => {
    const used = offers.mintOffer("bitbonsai", minter, 1_000);
    offers.redeemOffer(used.token, device, start, 2_000);
    offers.mintOffer("bitbonsai", minter, 1_000);
    offers.sweepOffers(61_000);
    expect(db.query("SELECT status FROM pair_offers").all()).toEqual([{ status: "used" }]);
    offers.sweepOffers(61_000 + 10 * 60_000);
    expect(db.query("SELECT COUNT(*) AS count FROM pair_offers").get()).toEqual({ count: 0 });
  });
});

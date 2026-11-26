import "./fixture.ts";
import { expect, test } from "bun:test";

// The notification relay must sign in with SASL so a SASL-only (private) Ergo admits it.
const { relayCredentials } = await import("../src/slirc-bot.ts");

test("the relay gets a stable SASL login derived from, but not equal to, the oper secret", async () => {
  const before = process.env.ERGO_OPER_PASS;
  process.env.ERGO_OPER_PASS = "oper-secret-one";
  try {
    const first = await relayCredentials();
    expect(first?.saslUser).toBe("slirc");
    expect(first?.saslPass).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first?.saslPass).not.toContain("oper-secret-one");
    expect(await relayCredentials()).toEqual(first);
    process.env.ERGO_OPER_PASS = "oper-secret-two";
    expect((await relayCredentials())?.saslPass).not.toBe(first?.saslPass);
  } finally {
    if (before === undefined) delete process.env.ERGO_OPER_PASS; else process.env.ERGO_OPER_PASS = before;
  }
});

test("without an oper secret the relay keeps its unauthenticated connection", async () => {
  const before = process.env.ERGO_OPER_PASS;
  delete process.env.ERGO_OPER_PASS;
  try { expect(await relayCredentials()).toBeNull(); }
  finally { if (before !== undefined) process.env.ERGO_OPER_PASS = before; }
});

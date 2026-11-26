import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import type { IrcOptions } from "../src/irc.ts";

process.chdir(new URL("..", import.meta.url).pathname);

const { db } = await import("../src/db.ts");
const { accountIrcPassword } = await import("../src/irc-key.ts");
await import("../src/accounts.ts");
db.query("UPDATE profiles SET avatar_path = 'test' WHERE account = 'bitbonsai'").run();
const certificates = await import("../src/irc-certificates.ts");
const { app } = await import("../src/server.ts");

const ownerToken = "owner-session";
const auth = () => ({ Cookie: `slirc_session=${ownerToken}` });
const certfp = "01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF";
const normalized = certfp.replaceAll(":", "").toLowerCase();

class FakeCertificateClient {
  events: string[] = [];
  private waiters: { predicate: (message: any) => boolean; resolve: () => void }[] = [];

  constructor(readonly options: IrcOptions, private fingerprints: Set<string>, private refuse = false) {}

  async connect() { this.events.push("connect"); }
  quit() { this.events.push("quit"); }

  send(line: string) {
    this.events.push(line);
    const command = line.match(/^PRIVMSG NickServ :CERT (.+)$/)?.[1];
    if (!command) return;
    if (this.refuse) return this.emit("Insufficient privileges");
    const [verb, ...params] = command.split(" ");
    const fingerprint = params.at(-1) || "";
    if (verb === "ADD") {
      this.fingerprints.add(fingerprint);
      this.emit("Certificate fingerprint successfully added");
    } else if (verb === "DEL") {
      this.fingerprints.delete(fingerprint);
      this.emit("Certificate fingerprint successfully removed");
    } else if (verb === "LIST") {
      this.emit(`There are ${this.fingerprints.size} certificate fingerprint(s) authorized for account bitbonsai.`);
      [...this.fingerprints].forEach((item, index) => this.emit(`${index + 1}: ${item}`));
    }
  }

  waitFor(predicate: (message: any) => boolean): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  private emit(text: string) {
    const message = { tags: {}, prefix: "NickServ!service@localhost", command: "NOTICE", params: ["cert", text] };
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      if (!this.waiters[index].predicate(message)) continue;
      this.waiters[index].resolve();
      this.waiters.splice(index, 1);
    }
  }
}

// The owner's derived password at counter 0.
const ownerPass = () => accountIrcPassword(db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick = 'bitbonsai'").get() as { account_id: string; irc_password_gen: number });

beforeEach(() => {
  db.query("DELETE FROM irc_certificates").run();
  db.query("DELETE FROM sessions").run();
  db.query("UPDATE accounts SET irc_password_gen = 0 WHERE nick = 'bitbonsai'").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
    .run(createHash("sha256").update(ownerToken).digest("hex"), Date.now());
  certificates.setCertificateIrcClientFactoriesForTests();
});

describe("IRC certificates", () => {
  test("normalizes OpenSSL SHA-256 fingerprints", () => {
    expect(certificates.normalizeCertificateFingerprint(`SHA256 Fingerprint=${certfp}`)).toBe(normalized);
    expect(certificates.normalizeCertificateFingerprint("not-a-fingerprint")).toBeNull();
  });

  test("adds, lists, and revokes a certificate through the account", async () => {
    const serverFingerprints = new Set<string>();
    const clients: FakeCertificateClient[] = [];
    certificates.setCertificateIrcClientFactoriesForTests((options) => {
      const client = new FakeCertificateClient(options, serverFingerprints);
      clients.push(client);
      return client;
    });

    const added = await app.request("/api/irc/certificates", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "WeeChat on MacBook", fingerprint: `SHA256 Fingerprint=${certfp}` }),
    });
    const certificate = await added.json() as { id: string; label: string; fingerprint: string; createdAt: number };
    expect(added.status).toBe(201);
    expect(certificate).toEqual(expect.objectContaining({ label: "WeeChat on MacBook", fingerprint: normalized }));
    expect(clients[0].options).toEqual(expect.objectContaining({ saslUser: "bitbonsai", saslPass: ownerPass() }));
    expect(clients[0].events).toContain(`PRIVMSG NickServ :CERT ADD ${normalized}`);
    expect(db.query("SELECT account, label, fingerprint FROM irc_certificates WHERE id = ?").get(certificate.id)).toEqual({ account: "bitbonsai", label: "WeeChat on MacBook", fingerprint: normalized });

    const listed = await app.request("/api/irc/certificates", { headers: auth() });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([certificate]);
    expect(clients[1].events).toContain("PRIVMSG NickServ :CERT LIST");

    const removed = await app.request(`/api/irc/certificates/${certificate.id}`, { method: "DELETE", headers: auth() });
    expect(removed.status).toBe(204);
    expect(clients[2].events).toContain(`PRIVMSG NickServ :CERT DEL ${normalized}`);
    expect(db.query("SELECT 1 FROM irc_certificates WHERE id = ?").get(certificate.id)).toBeNull();
  });

  test("falls back to targeted oper syntax after NickServ refuses self syntax", async () => {
    const serverFingerprints = new Set<string>();
    const account = new FakeCertificateClient({ host: "", port: 0, nick: "account" }, serverFingerprints, true);
    const oper = new FakeCertificateClient({ host: "", port: 0, nick: "oper" }, serverFingerprints);
    certificates.setCertificateIrcClientFactoriesForTests(() => account, async () => oper);

    await certificates.addCertificate("bitbonsai", ownerPass(), normalized);

    expect(account.events).toContain(`PRIVMSG NickServ :CERT ADD ${normalized}`);
    expect(oper.events).toContain(`PRIVMSG NickServ :CERT ADD bitbonsai ${normalized}`);
    expect(serverFingerprints).toEqual(new Set([normalized]));
  });

  test("manages a suspended account's certificates through the oper when its own login is dropped", async () => {
    // A removed person is suspended before their certificates go; Ergo then closes their SASL login.
    const serverFingerprints = new Set([normalized]);
    const account = new FakeCertificateClient({ host: "", port: 0, nick: "account" }, serverFingerprints);
    account.connect = async () => { throw new Error("IRC connection closed"); };
    const oper = new FakeCertificateClient({ host: "", port: 0, nick: "oper" }, serverFingerprints);
    certificates.setCertificateIrcClientFactoriesForTests(() => account, async () => oper);

    expect(await certificates.listCertificates("bitbonsai", ownerPass())).toEqual([normalized]);
    await certificates.removeCertificate("bitbonsai", ownerPass(), normalized);

    expect(oper.events).toContain("PRIVMSG NickServ :CERT LIST bitbonsai");
    expect(oper.events).toContain(`PRIVMSG NickServ :CERT DEL bitbonsai ${normalized}`);
    expect(serverFingerprints).toEqual(new Set());
  });

  test("rejects invalid fingerprints before IRC", async () => {
    const response = await app.request("/api/irc/certificates", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Laptop", fingerprint: "1234" }),
    });
    expect(response.status).toBe(400);
    expect(db.query("SELECT COUNT(*) AS count FROM irc_certificates").get()).toEqual({ count: 0 });
  });
});

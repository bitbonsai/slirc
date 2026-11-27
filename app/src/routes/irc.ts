import { verifiedHuman } from "../http/session.ts";
import { db } from "../db.ts";
import { serializeIrcDeviceChange, clearIrcResetNotice, IRC_RESET_CLIENTS, IRC_RESET_BOTS } from "../http/irc-devices.ts";
import { randomBytes } from "node:crypto";
import { rotateIrcPassword } from "../accounts.ts";
import { appError } from "../http/common.ts";
import { listCertificates, normalizeCertificateFingerprint, addCertificate, removeCertificate } from "../irc-certificates.ts";
import { Hono } from "hono";

export const irc = new Hono();

irc.get("/api/irc/devices", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const rows = db.query("SELECT id, label, created_at FROM irc_devices WHERE account = ? COLLATE NOCASE ORDER BY created_at DESC").all(account.nick) as { id: string; label: string; created_at: number }[];
  return c.json(rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at })));
});

irc.post("/api/irc/devices", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 80 || /[\r\n]/.test(label)) return c.json({ error: "Enter a device name." }, 400);
  try {
    const result = await serializeIrcDeviceChange(async () => {
      const device = { id: randomBytes(12).toString("base64url"), label, createdAt: Date.now() };
      const password = await rotateIrcPassword(account.nick);
      db.query("INSERT INTO irc_devices (id, account, label, created_at) VALUES (?, ?, ?, ?)").run(device.id, account.nick, device.label, device.createdAt);
      clearIrcResetNotice(account.nick, IRC_RESET_CLIENTS);
      return { device, password };
    });
    return c.json(result, 201);
  } catch (error) {
    return appError(c, error, "Could not connect IRC client.");
  }
});

irc.delete("/api/irc/devices/:id", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return c.json({ error: "device not found" }, 404);
  try {
    const password = await serializeIrcDeviceChange(async () => {
      const device = db.query("SELECT 1 FROM irc_devices WHERE id = ? AND account = ? COLLATE NOCASE").get(id, account.nick);
      if (!device) return null;
      const password = await rotateIrcPassword(account.nick);
      db.query("DELETE FROM irc_devices WHERE id = ? AND account = ? COLLATE NOCASE").run(id, account.nick);
      clearIrcResetNotice(account.nick, IRC_RESET_CLIENTS);
      return password;
    });
    return password ? c.json({ password }) : c.json({ error: "device not found" }, 404);
  } catch (error) {
    return appError(c, error, "Could not remove IRC client.");
  }
});

// New password: the same rotation as adding a client, without adding one. Shown once, like every
// password on this page; the old one stops working for every password client at once.
irc.post("/api/irc/password", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  try {
    const password = await serializeIrcDeviceChange(async () => {
      const password = await rotateIrcPassword(account.nick);
      clearIrcResetNotice(account.nick, IRC_RESET_CLIENTS);
      return password;
    });
    return c.json({ password });
  } catch (error) {
    return appError(c, error, "Could not make a new IRC password.");
  }
});

// Dismissing the "your IRC password changed" note. kind is "clients" or "bots".
irc.post("/api/irc/reset-notice", async (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const bit = body?.kind === "clients" ? IRC_RESET_CLIENTS : body?.kind === "bots" ? IRC_RESET_BOTS : 0;
  if (!bit) return c.json({ error: "unknown note" }, 400);
  clearIrcResetNotice(account.nick, bit);
  return c.body(null, 204);
});

irc.get("/api/irc/certificates", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  try {
    return c.json(await serializeIrcDeviceChange(async () => {
      const fingerprints = new Set(await listCertificates(account.nick, account.ircPassword));
      const rows = db.query("SELECT id, label, fingerprint, created_at FROM irc_certificates WHERE account = ? COLLATE NOCASE ORDER BY created_at DESC").all(account.nick) as { id: string; label: string; fingerprint: string; created_at: number }[];
      for (const row of rows) if (!fingerprints.has(row.fingerprint)) db.query("DELETE FROM irc_certificates WHERE id = ?").run(row.id);
      for (const fingerprint of fingerprints) {
        if (!rows.some((row) => row.fingerprint === fingerprint)) {
          db.query("INSERT INTO irc_certificates (id, account, label, fingerprint, created_at) VALUES (?, ?, 'Certificate', ?, ?)")
            .run(randomBytes(12).toString("base64url"), account.nick, fingerprint, Date.now());
        }
      }
      return (db.query("SELECT id, label, fingerprint, created_at FROM irc_certificates WHERE account = ? COLLATE NOCASE ORDER BY created_at DESC").all(account.nick) as { id: string; label: string; fingerprint: string; created_at: number }[])
        .map((row) => ({ id: row.id, label: row.label, fingerprint: row.fingerprint, createdAt: row.created_at }));
    }));
  } catch (error) {
    return appError(c, error, "Could not load certificates.");
  }
});

irc.post("/api/irc/certificates", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const fingerprint = typeof body.fingerprint === "string" ? normalizeCertificateFingerprint(body.fingerprint) : null;
  if (!label || label.length > 80 || /[\r\n]/.test(label)) return c.json({ error: "Enter a certificate name." }, 400);
  if (!fingerprint) return c.json({ error: "Enter a SHA-256 certificate fingerprint." }, 400);
  try {
    const certificate = await serializeIrcDeviceChange(async () => {
      if (db.query("SELECT 1 FROM irc_certificates WHERE account = ? COLLATE NOCASE AND fingerprint = ?").get(account.nick, fingerprint)) return null;
      await addCertificate(account.nick, account.ircPassword, fingerprint);
      const certificate = { id: randomBytes(12).toString("base64url"), label, fingerprint, createdAt: Date.now() };
      db.query("INSERT INTO irc_certificates (id, account, label, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(certificate.id, account.nick, certificate.label, certificate.fingerprint, certificate.createdAt);
      return certificate;
    });
    return certificate ? c.json(certificate, 201) : c.json({ error: "Certificate already added." }, 409);
  } catch (error) {
    return appError(c, error, "Could not add certificate.");
  }
});

irc.delete("/api/irc/certificates/:id", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return c.json({ error: "certificate not found" }, 404);
  try {
    const removed = await serializeIrcDeviceChange(async () => {
      const certificate = db.query("SELECT fingerprint FROM irc_certificates WHERE id = ? AND account = ? COLLATE NOCASE").get(id, account.nick) as { fingerprint: string } | null;
      if (!certificate) return false;
      await removeCertificate(account.nick, account.ircPassword, certificate.fingerprint);
      db.query("DELETE FROM irc_certificates WHERE id = ? AND account = ? COLLATE NOCASE").run(id, account.nick);
      return true;
    });
    return removed ? c.body(null, 204) : c.json({ error: "certificate not found" }, 404);
  } catch (error) {
    return appError(c, error, "Could not remove certificate.");
  }
});

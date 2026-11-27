import { countedMail } from "../mail-count.ts";
import { Resend } from "resend";
import { hash, devLinks, appOrigin } from "./session.ts";
import { accountByNick } from "../accounts.ts";
import { db } from "../db.ts";
import { randomBytes, randomInt } from "node:crypto";
import { isValidNext } from "../rooms.ts";
import { magicLinkEmail, directInviteEmail, inviteEmail } from "../email.ts";
import { createLimiter } from "../request-security.ts";

// Counted per day and kind (mail-count.ts) so the Resend free tier is not hit by surprise.
export const resend = process.env.RESEND_API_KEY ? countedMail(new Resend(process.env.RESEND_API_KEY)) : null;

// The code is hashed with the nick so equal digits for two people never share a row.
export const codeHash = (nick: string, code: string) => hash(`${nick.toLowerCase()}:${code}`);

// Mints a sign-in link plus the 6-digit code mailed with it; sending lives in sendMagicLink.
// Both live on one magic_links row, so they expire together and using either burns both.
async function magicLinkUrl(account: NonNullable<ReturnType<typeof accountByNick>>, next = "/", host?: string | null): Promise<{ url: string; code: string } | undefined> {
  const now = Date.now();
  const recent = db.query("SELECT 1 FROM magic_links WHERE nick = ? AND created_at > ?").get(account.nick, now - 60_000);
  if (recent && !devLinks) return;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.query("DELETE FROM magic_links WHERE expires_at < ?").run(now);
  db.query("INSERT INTO magic_links (token_hash, nick, expires_at, created_at, code_hash) VALUES (?, ?, ?, ?, ?)")
    .run(tokenHash, account.nick, now + 15 * 60_000, now, codeHash(account.nick, code));
  const target = isValidNext(next) ? next : "/";
  const url = `${appOrigin(host)}/auth/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(target)}`;
  if (devLinks) console.log(`magic link for ${account.nick}: ${url} (code ${code})`);
  return { url, code };
}

export async function sendMagicLink(account: NonNullable<ReturnType<typeof accountByNick>>, next = "/", host?: string | null): Promise<string | undefined> {
  const minted = await magicLinkUrl(account, next, host);
  if (!minted) return;
  const { url, code } = minted;
  if (devLinks) return url;
  if (!resend || !process.env.RESEND_FROM) return;
  const email = magicLinkEmail({ url, code, nick: account.nick, verified: !!account.verifiedAt, origin: appOrigin(host) });
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to: account.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
  }, { idempotencyKey: `magic-link/${hash(url)}` });
  if (error) console.error("magic link email failed:", error.message);
}

export async function sendInvitationVerification(account: NonNullable<ReturnType<typeof accountByNick>>, token: string, host?: string | null) {
  const minted = await magicLinkUrl(account, `/join/${token}`, host);
  if (!minted) return { status: "limited" as const };
  if (devLinks) return { status: "sent" as const, devLink: minted.url };
  if (!resend || !process.env.RESEND_FROM) {
    db.query("DELETE FROM magic_links WHERE token_hash = ?").run(hash(new URL(minted.url).searchParams.get("token") || ""));
    return { status: "failed" as const };
  }
  const email = magicLinkEmail({ url: minted.url, code: minted.code, nick: account.nick, verified: !!account.verifiedAt, origin: appOrigin(host) });
  try {
    const { error } = await resend.emails.send({ from: process.env.RESEND_FROM, to: account.email,
      subject: email.subject, html: email.html, text: email.text }, { idempotencyKey: `invite-signup/${hash(token)}/${hash(minted.url)}` });
    if (error) {
      db.query("DELETE FROM magic_links WHERE token_hash = ?").run(hash(new URL(minted.url).searchParams.get("token") || ""));
      return { status: "failed" as const };
    }
    return { status: "sent" as const };
  } catch {
    return { status: "uncertain" as const };
  }
}

// Invitation emails name the sender by their profile name and verified address. The profile name is
// free text and lands in the subject header, so control characters (CR/LF) are flattened.
export const inviterName = (nick: string) =>
  (db.query("SELECT full_name FROM profiles WHERE account = ?").get(nick) as { full_name: string | null } | null)?.full_name?.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim() || nick;

export async function sendEmailInvite({ to, inviter, inviterEmail, destination, token, id, host }: {
  to: string; inviter: string; inviterEmail: string; destination: { type: "dm" | "channel" | "group"; channel: string | null };
  token: string; id: string; host?: string | null;
}): Promise<"sent" | "failed" | "uncertain"> {
  const url = `${appOrigin(host)}/join/${token}`;
  if (devLinks) {
    console.log(`invite link for ${to}: ${url}`);
    return "sent";
  }
  if (!resend || !process.env.RESEND_FROM) return "failed";
  const email = destination.type === "dm"
    ? directInviteEmail({ url, inviter, inviterEmail, origin: appOrigin(host) })
    : inviteEmail({ url, channel: destination.channel!, inviter, inviterEmail, origin: appOrigin(host) });
  try {
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM, to, subject: email.subject, html: email.html, text: email.text,
    }, { idempotencyKey: `invite/${id}/${hash(token)}` });
    if (error) {
      console.error("invite email failed:", error.message);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error("invite email outcome uncertain:", error instanceof Error ? error.message : error);
    return "uncertain";
  }
}

export const mailLimit = createLimiter({ limit: 5 });

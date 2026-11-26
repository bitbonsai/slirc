// Pure fixture plan + execution guard for scripts/boot-seed.ts.
//
// No database, network, or Ergo import may live here: boot-seed.ts imports it *before*
// the guard so a non-local run can be rejected without opening SQLite or dialing IRC.
// Keep every export deterministic and side-effect free.

export const BOOT_SEED_VERSION = "v2";
export const BOOT_CHANNEL = "#dev-test";
export const BOOT_OPEN_CHANNEL = "#dev-open";
export const BOOT_OPEN_CHANNEL_MODES = "+Mu-R";
export const FIXTURE_DOMAIN = "example.test";
// Fixture status is labelled once, in the room topic, instead of on every line. The
// messages below read like ordinary chat across disposable @example.test accounts.
export const BOOT_CHANNEL_TOPIC = "Fixture room \u2014 local seed data; three test accounts and the owner.";
export const BOOT_OPEN_CHANNEL_TOPIC = "Public test room \u2014 local fixture data; open to signed-in accounts.";

export type BootPerson = { nick: string; realName: string; email: string };

// Exactly three disposable humans. `client-seed.ts` may already have created eve; the
// script reuses an existing nick/email instead of provisioning a duplicate.
export const bootPeople: BootPerson[] = [
  { nick: "eve", realName: "Eve Marlow", email: `eve@${FIXTURE_DOMAIN}` },
  { nick: "ben", realName: "Ben Ortiz", email: `ben@${FIXTURE_DOMAIN}` },
  { nick: "ada", realName: "Ada Fields", email: `ada@${FIXTURE_DOMAIN}` },
];

// Real fixture messages: a generic OpenGraph card, YouTube, Pexels stills and one direct
// Giphy GIF. The GIF is a verified, neutral ocean clip (media.giphy.com/media/HGvjR72DXRHWw);
// no meme characters, joke text or watermarks. Fixture status lives in the room topic.
export const bootChannelMessages: { author: string; text: string }[] = [
  { author: "eve", text: "GitHub card check https://github.com/ergochat/ergo" },
  { author: "ben", text: "YouTube card check https://www.youtube.com/watch?v=aqz-KE-bpKQ" },
  { author: "ada", text: "@OWNER the layout reads fine one-handed" },
  { author: "eve", text: "Pexels image https://images.pexels.com/photos/3184291/pexels-photo-3184291.jpeg?auto=compress&cs=tinysrgb&w=1200" },
  { author: "ben", text: "[Giphy: ocean sunrise] https://media.giphy.com/media/HGvjR72DXRHWw/giphy.gif" },
  { author: "ada", text: "Another Pexels image https://images.pexels.com/photos/1181671/pexels-photo-1181671.jpeg?auto=compress&cs=tinysrgb&w=1200" },
];

export const bootOpenMessages: { author: string; text: string }[] = [
  { author: "ada", text: "Public room check: every signed-in account can join #dev-open." },
  { author: "ben", text: "Pexels image https://images.pexels.com/photos/3184338/pexels-photo-3184338.jpeg?auto=compress&cs=tinysrgb&w=1200" },
  { author: "eve", text: "[Giphy: ocean sunrise] https://media.giphy.com/media/HGvjR72DXRHWw/giphy.gif" },
];

export type BootLine = { from: "a" | "b"; text: string };

// DMs include the owner so the signed-in dev account can inspect them; both directions speak.
export const bootDirectMessages: { id: string; a: string; b: string; lines: BootLine[] }[] = [
  {
    id: "owner-ada", a: "owner", b: "ada",
    lines: [
      { from: "b", text: "Can you check the Pexels image on your phone?" },
      { from: "a", text: "It loads inline; the preview stays in the thread." },
      { from: "b", text: "Great, thanks." },
    ],
  },
  {
    id: "owner-ben", a: "owner", b: "ben",
    lines: [
      { from: "b", text: "Quick DM test; I can see this as a real DM." },
      { from: "a", text: "Received; checking history after reload." },
      { from: "b", text: "Looks good." },
    ],
  },
];

// One `meta` key per message, keyed by room, sender and index. The value is a two-phase
// StampState: `sending` is written *before* transmission, `confirmed` only after Ergo echoes
// the line. A rerun skips a confirmed line silently and an uncertain (`sending`) line with a
// warning; it never blindly replays, so a crash between send and echo cannot duplicate a
// message. This is deliberately not exactly-once: a line that was never transmitted is also
// skipped until the operator clears its row (see boot-seed.ts).
export function messageStamp(kind: "channel" | "dm", subject: string, sender: string, index: number): string {
  return `boot-seed:${BOOT_SEED_VERSION}:msg:${kind}:${subject}:${sender}:${index}`;
}

export type StampState = { status: "sending" | "confirmed"; at: number };

// How a rerun treats a message key.
export function resumeAction(state: StampState | null): "send" | "skip" | "warn" {
  if (!state) return "send";
  return state.status === "confirmed" ? "skip" : "warn";
}

export type MembershipMessage = { command: string; prefix?: string; params: string[] };

// Track the client's own channel membership from raw IRC lines. Wiring this into the
// IrcClient constructor's onMessage lets a set fill during connect(), so ensureJoin()
// recognises an always-on autojoin and does not send a duplicate JOIN whose echo is missed.
// (A JOIN/PART from another nick never changes membership.)
export function trackMembership(channels: Set<string>, nick: string, message: MembershipMessage): void {
  const from = (message.prefix || "").split("!")[0].toLowerCase();
  const self = nick.toLowerCase();
  const channel = message.params[0];
  if (message.command === "JOIN" && from === self && channel) channels.add(channel);
  else if (message.command === "PART" && from === self && channel) channels.delete(channel);
  else if (message.command === "KICK" && message.params[1]?.toLowerCase() === self && channel) channels.delete(channel);
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

// Two factors, both explicit: the opt-in nothing sets automatically, and the isolated
// slirc2 profile flag the coordinator injects. Production sets neither.
export function bootSeedGuard(env: Record<string, string | undefined>): GuardResult {
  if (env.SLIRC_BOOT_SEED !== "true") {
    return { ok: false, reason: "Boot seed requires the explicit opt-in SLIRC_BOOT_SEED=true" };
  }
  if (env.SLIRC_DEV_PROFILE !== "slirc2") {
    return { ok: false, reason: `Boot seed requires SLIRC_DEV_PROFILE=slirc2, got ${env.SLIRC_DEV_PROFILE || "(unset)"}` };
  }
  return { ok: true };
}

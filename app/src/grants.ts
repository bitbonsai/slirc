// Channel lifecycle operations executed through one registered IRC oper account.

import { randomBytes } from "node:crypto";
import { ergoOperUser } from "./config.ts";
import { SERVICE_BOT_NICKS } from "../shared/service-bots.ts";
import { foldIdentifier as fold } from "../shared/fold.ts";
import { IrcClient, type ParsedMessage } from "./irc.ts";
import { clearChannelHistory, deleteHistoryMsgid, joinHistoryChannel, validHistoryChannel, type ChannelHistoryResult } from "./history.ts";

const host = () => process.env.ERGO_HOST || "127.0.0.1";
const port = () => Number(process.env.ERGO_PORT || 6667);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A NAMES round trip is normally sub-second. After the REGISTER burst, Ergo can push the reply a
// few seconds behind the +si/+I/REGISTER commands, so the post-registration proof gets a longer,
// still bounded window (a local fakelag run saw 3.0s). Never wait forever: a timeout is uncertain.
const NAMES_TIMEOUT_MS = 2_500;
const NAMES_BURST_TIMEOUT_MS = 8_000;
const serviceNick = ergoOperUser;

function operPassword(): string {
  const password = process.env.ERGO_OPER_PASS;
  if (!password) throw new Error("ERGO_OPER_PASS required");
  return password;
}

// Accounts that hold permanent connections of their own (the relay and every room helper);
// always-on would only keep ghosts of them.
const SERVICE_ACCOUNTS = SERVICE_BOT_NICKS;
let serviceAccountsOptedOut = false;

export function resetServiceAccountsOptOutForTests(): void {
  serviceAccountsOptedOut = false;
}

export async function operClient(capabilities?: string[], timeoutMs = NAMES_BURST_TIMEOUT_MS): Promise<IrcClient> {
  const deadline = performance.now() + timeoutMs;
  const user = serviceNick();
  const password = operPassword();
  const nick = `${user.slice(0, 20)}-${randomBytes(3).toString("hex")}`;
  const client = new IrcClient({ host: host(), port: port(), nick, realname: "Slirc app", saslUser: user, saslPass: password, capabilities });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect(Math.max(0, deadline - performance.now()));
    let failure = "";
    const reply = client.waitFor((message) => {
      if (message.command === "381") return true;
      if (message.command === "464" || message.command === "491") {
        failure = message.params.at(-1) || message.command;
        return true;
      }
      return false;
    });
    // Service accounts must never be always-on: with Ergo's always-on default (opt-out), a SASL
    // login reattaches to a lingering session and OPER goes unanswered, crash-looping the app.
    // The account can switch itself off without oper rights, so do it before OPER; the next
    // connection is then a plain one.
    client.send("NS SET ALWAYS-ON false");
    client.send(`OPER ${user} ${password}`);
    const result = await Promise.race([
      reply.then(() => !failure),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, Math.min(2_500, deadline - performance.now())));
      }),
    ]);
    if (!result) throw new Error(`OPER failed: ${failure || "no reply from Ergo"}`);
    if (!serviceAccountsOptedOut) {
      serviceAccountsOptedOut = true;
      for (const nick of SERVICE_ACCOUNTS) client.send(`NS SASET ${nick} ALWAYS-ON false`);
    }
    return client;
  } catch (error) {
    client.disconnect();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Ergo processes a connection's commands in order but only if they arrive before QUIT. A PING round
// trip before quitting guarantees every SAMODE above was applied, so two operations on separate
// connections cannot land out of order.
async function release(client: IrcClient): Promise<void> {
  try {
    const token = `flush-${randomBytes(3).toString("hex")}`;
    const pong = client.waitFor((message) => message.command === "PONG" && message.params.at(-1) === token);
    client.send(`PING ${token}`);
    await Promise.race([pong, sleep(2_500)]);
  } catch {}
  client.quit();
}

const serviceError = /\b(?:cannot|can't|could not|does not|failed|invalid|insufficient|not logged|no such|unknown|error)\b/i;

// One long-lived oper connection for the app process. Every fresh connection used to join, op itself and
// quit, and IRC clients replaying events saw an oper-nick-<hex> parade. The session joins a channel once,
// serializes operations, and reconnects on the next call after a drop. OPER_PERSISTENT=0 restores the
// one-shot client (tests, one-off scripts).
const persistent = () => process.env.OPER_PERSISTENT !== "0";
type Session = { client: IrcClient; joined: Set<string>; opped: Set<string>; alive: boolean };
let session: Session | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function openSession(): Promise<Session> {
  if (session?.alive) return session;
  const user = serviceNick();
  const password = operPassword();
  const state: Session = { client: null as unknown as IrcClient, joined: new Set(), opped: new Set(), alive: false };
  const client = new IrcClient({
    // The nick must differ from the oper name: Ergo ignores OPER from a connection whose
    // nick is the oper account's own name (the reply never arrives, so the session times
    // out), while SASL as the same account is fine. Suffixed nicks also keep the oper's
    // join/part churn greppable for history-prune.
    host: host(), port: port(), nick: `${user.slice(0, 24)}-${randomBytes(3).toString("hex")}`, realname: "Slirc app", saslUser: user, saslPass: password,
    onClose: () => { state.alive = false; if (session === state) session = null; },
  });
  state.client = client;
  await client.connect();
  let failure = "";
  const reply = client.waitFor((message) => {
    if (message.command === "381") return true;
    if (message.command === "464" || message.command === "491") { failure = message.params.at(-1) || message.command; return true; }
    return false;
  });
  client.send(`OPER ${user} ${password}`);
  if (!await Promise.race([reply.then(() => !failure), sleep(2_500).then(() => false)])) {
    client.quit();
    throw new Error(`OPER failed: ${failure || "no reply from Ergo"}`);
  }
  state.alive = true;
  session = state;
  return state;
}

// Run one operation against the shared oper session, or a throwaway client when persistence is off.
async function withOper<T>(run: (client: IrcClient, join: (channel: string, op?: boolean) => void) => Promise<T>): Promise<T> {
  if (!persistent()) {
    const client = await operClient();
    try {
      return await run(client, (channel, op = true) => {
        client.send(`SAJOIN ${client.nick} ${channel}`);
        if (op) client.send(`SAMODE ${channel} +o ${client.nick}`);
      });
    } finally {
      await release(client);
    }
  }
  const task = queue.then(async () => {
    const current = await openSession();
    const { client } = current;
    const join = (channel: string, op = true) => {
      if (!current.joined.has(channel)) { client.send(`SAJOIN ${client.nick} ${channel}`); current.joined.add(channel); }
      if (op && !current.opped.has(channel)) { client.send(`SAMODE ${channel} +o ${client.nick}`); current.opped.add(channel); }
    };
    try {
      return await run(client, join);
    } finally {
      // Same ordering guarantee as release(): a PING round trip before the next caller proceeds.
      try {
        const token = `flush-${randomBytes(3).toString("hex")}`;
        const pong = client.waitFor((message) => message.command === "PONG" && message.params.at(-1) === token);
        client.send(`PING ${token}`);
        await Promise.race([pong, sleep(2_500)]);
      } catch {}
    }
  });
  queue = task.catch(() => {});
  return task;
}

// Channels the session left behind (deleted) must be joined again if recreated.
function forgetChannel(channel: string): void {
  session?.joined.delete(channel);
  session?.opped.delete(channel);
}

// Live private-channel proof for the session transport. Reads +s and +i over a bounded, short-lived
// management connection that is closed in `finally`, so a timed-out probe cannot accumulate waiters
// under repeated calls. MODE is a read-only existence probe; it never SAJOINs (a SAJOIN to a
// channel Ergo no longer has would create an empty foreign room). Returns null when the channel is
// unknown, the reply is addressed to another client, or the reply times out: every caller treats
// null as "not safe to join/deliver" (fail closed).
export type PrivateChannelMode = { secret: boolean; inviteOnly: boolean };
export async function readPrivateChannelMode(channel: string, timeoutMs = 2_500): Promise<PrivateChannelMode | null> {
  if (!/^#[a-z0-9][a-z0-9_-]{0,63}$/i.test(channel)) return null;
  const target = channel.toLowerCase();
  let client: IrcClient | null = null;
  try {
    client = await operClient();
    const nick = client.nick.toLowerCase();
    let result: PrivateChannelMode | null = null;
    const reply = client.waitFor((message) => {
      // RPL_CHANNELMODEIS/ERR_NOSUCHCHANNEL params are [recipient, channel, ...]; both must match.
      if ((message.params[0] || "").toLowerCase() !== nick) return false;
      if ((message.params[1] || "").toLowerCase() !== target) return false;
      if (message.command === "324") {
        const flags = message.params[2] || "";
        result = { secret: flags.includes("s"), inviteOnly: flags.includes("i") };
        return true;
      }
      if (message.command === "403") { result = null; return true; }
      return false;
    });
    client.send(`MODE ${channel}`);
    const answered = await Promise.race([reply.then(() => true), sleep(timeoutMs).then(() => false)]);
    return answered ? result : null;
  } catch { return null; }
  finally {
    client?.quit();
  }
}

export async function serviceCommand(client: IrcClient, service: "ChanServ" | "NickServ", command: string, expected: RegExp): Promise<string> {
  let notice = "";
  const reply = client.waitFor((message: ParsedMessage) => {
    if (message.command !== "NOTICE" || message.prefix?.split("!", 1)[0].toLowerCase() !== service.toLowerCase()) return false;
    notice = message.params.at(-1) || "";
    expected.lastIndex = 0;
    return expected.test(notice) || serviceError.test(notice);
  });
  client.send(`PRIVMSG ${service} :${command}`);
  const received = await Promise.race([reply.then(() => true), sleep(2_500).then(() => false)]);
  expected.lastIndex = 0;
  if (!received || !expected.test(notice)) throw new Error(`${service} ${command.split(" ")[0]} failed: ${notice || `no reply from ${service}`}`);
  return notice;
}

// Agents are opted out of the account-wide always-on default (instant.md): they run their own
// persistent connection already, so going always-on/away on a dropped socket would hide a real
// disconnect from owner-side offline detection instead of surfacing it.
export async function setAlwaysOn(nick: string, enabled: boolean): Promise<void> {
  await withOper(async (client) => {
    // Ergo's exact NickServ SASET reply text isn't pinned down here; any reply at all confirms
    // the command was processed (serviceCommand still throws on no reply or a known error phrase).
    await serviceCommand(client, "NickServ", `SASET ${nick} ALWAYS-ON ${enabled}`, /\S/);
  });
}

export async function transferChannel(client: IrcClient, channel: string, owner: string): Promise<void> {
  const prompt = await serviceCommand(client, "ChanServ", `TRANSFER ${channel} ${owner}`, /To confirm your channel transfer/i);
  const code = prompt.match(/TRANSFER\s+\S+\s+\S+\s+(\S+)$/i)?.[1];
  if (!code) throw new Error(`ChanServ TRANSFER failed: confirmation code missing`);
  await serviceCommand(client, "ChanServ", `TRANSFER ${channel} ${owner} ${code}`, /Successfully transferred channel/i);
}

// +I only: the inviting member sends INVITE over their own connection so the invite is attributed to them.
export async function allowChannelAccess(channel: string, nick: string): Promise<void> {
  await withOper(async (client) => { client.send(`SAMODE ${channel} +I ${nick}`); });
}

// Persistent channel operator through ChanServ AMODE: Ergo ops the account whenever it joins, and
// at once if it is already there. The oper's chanreg capability may set it on any registered
// channel; "No changes" means the account already had it, so a repeat is harmless.
export async function grantChannelOps(channel: string, nicks: readonly string[]): Promise<void> {
  if (!nicks.length) return;
  await withOper(async (client) => {
    for (const nick of nicks) {
      const reply = await serviceCommand(client, "ChanServ", `AMODE ${channel} +o ${nick}`, /persistent mode|no changes|not registered/i);
      if (/not registered/i.test(reply)) throw new Error(reply);
    }
  });
}

export async function grantChannelAccess(channel: string, nick: string): Promise<void> {
  await withOper(async (client, join) => {
    client.send(`SAMODE ${channel} +I ${nick}`);
    join(channel);
    client.send(`INVITE ${nick} ${channel}`);
  });
}

// Who is inside a channel, by account. WHOX answers an oper for a +s channel without joining it, and
// the account field cannot be faked the way a nick like `<oper>-abc123` can ("0" means no account).
// A channel that does not exist answers with an empty list. No end-of-list reply is a failure.
const WHO_TOKEN = "152";
export type Occupant = { nick: string; account: string };
export async function channelOccupants(client: IrcClient, channel: string, timeoutMs = NAMES_TIMEOUT_MS): Promise<Occupant[]> {
  const self = fold(client.nick);
  const occupants: Occupant[] = [];
  const reply = client.waitFor((message) => {
    if (fold(message.params[0] || "") !== self) return false;
    if (message.command === "354" && message.params[1] === WHO_TOKEN) {
      occupants.push({ nick: message.params[2] || "", account: fold(message.params[3] || "0") });
      return false;
    }
    return message.command === "315" && fold(message.params[1] || "") === fold(channel);
  });
  client.send(`WHO ${channel} %tna,${WHO_TOKEN}`);
  if (!await Promise.race([reply.then(() => true), sleep(timeoutMs).then(() => false)])) {
    throw new Error(`WHO for ${channel} got no reply`);
  }
  return occupants;
}

// The app itself: any connection logged in as the oper account, and the relay account `slirc`,
// which JOINs every channel that has member rows (slirc-bot.ts), sometimes before it is provisioned.
const appAccounts = () => new Set([ergoOperUser().toLowerCase(), "slirc"]);

// Creation of a channel nobody else has touched. Like createThreadChannel, it refuses a channel
// someone already sits in (a squatter who JOINed a predictable `#dm-` name first) or one that is
// already registered, then kicks anyone who slipped in between the check and the +si lock.
// `adopt` keeps the old reconfigure-in-place behaviour for the seed scripts' own fixed rooms only;
// never pass it for a name a user can predict.
export async function createChannel(channel: string, owner: string, visibility: "workspace" | "secret", options: { adopt?: boolean } = {}): Promise<void> {
  const modes = visibility === "secret" ? "+si-Rt" : "+R-sit";
  await withOper(async (client, join) => {
    if (options.adopt) {
      join(channel);
      await serviceCommand(client, "ChanServ", `REGISTER ${channel}`, /successfully registered|already registered/i);
      await transferChannel(client, channel, owner);
      client.send(`SAMODE ${channel} ${modes}`);
      client.send(`SAMODE ${channel} +I slirc`);
      return;
    }
    const app = appAccounts();
    if ((await channelOccupants(client, channel)).some((occupant) => !app.has(occupant.account))) {
      throw new Error(`channel ${channel} already has members; refusing to take it over`);
    }
    join(channel);
    try {
      const notice = await serviceCommand(client, "ChanServ", `REGISTER ${channel}`, /successfully registered|already registered/i);
      if (/already registered/i.test(notice)) throw new Error(`channel ${channel} is already registered; refusing to adopt it`);
      client.send(`SAMODE ${channel} ${modes}`);
      client.send(`SAMODE ${channel} +I slirc`);
      for (const occupant of await channelOccupants(client, channel, NAMES_BURST_TIMEOUT_MS)) {
        if (!app.has(occupant.account)) client.send(`KICK ${channel} ${occupant.nick} :Private conversation`);
      }
      await transferChannel(client, channel, owner);
    } catch (error) {
      client.send(`PART ${channel}`);
      forgetChannel(channel);
      throw error;
    }
  });
}

export async function setChannelMode(channel: string, mode: string): Promise<void> {
  await withOper(async (client) => { client.send(`SAMODE ${channel} ${mode}`); });
}

export async function setChannelTopic(channel: string, topic: string): Promise<void> {
  await withOper(async (client, join) => {
    join(channel, false);
    // Drop +t so members can set the topic themselves from now on; this oper path is the one-time fallback.
    client.send(`SAMODE ${channel} -t`);
    client.send(`TOPIC ${channel} :${topic}`);
  });
}

export async function revokeChannelAccess(channel: string, nick: string): Promise<void> {
  await withOper(async (client) => { client.send(`SAMODE ${channel} -I ${nick}`); });
}

// Reopening a DM that already passes the proof changes nothing. Anything else must be a fresh
// channel: createChannel refuses one that exists, so a squatted or half-provisioned DM fails closed.
export async function createDirectChannel(channel: string, owner: string, members: string[]): Promise<void> {
  if (await readDirectChannelReady(channel, members)) return;
  await createChannel(channel, owner, "secret");
  await makeChannelSecret(channel, members);
  if (!await readDirectChannelReady(channel, members)) throw new Error(`DM ${channel} provisioning was not confirmed`);
}

// PONG only proves command processing, not successful mode changes. Read back the registered
// channel, +si, the complete +I list and everyone inside on a dedicated connection. SAMODE +I without
// an argument lists invite exceptions with oper privileges; it neither joins nor creates a missing
// channel. The proof holds only if the people inside and the invite exceptions are exactly the
// members plus the app's own accounts: a squatter, or a mask a squatter left while holding op, fails it.
export async function readDirectChannelReady(channel: string, members: string[], timeoutMs = NAMES_BURST_TIMEOUT_MS): Promise<boolean> {
  // One budget includes TCP/TLS, CAP, SASL, welcome, OPER and the complete proof.
  const deadline = performance.now() + timeoutMs;
  if (!/^#[a-z0-9][a-z0-9_-]{0,63}$/i.test(channel)) return false;
  const target = fold(channel);
  let client: IrcClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client = await operClient(undefined, Math.max(0, deadline - performance.now()));
    const recipient = fold(client.nick);
    const token = `dm-proof-${randomBytes(8).toString("hex")}`;
    let privateMode = false, listComplete = false, registered = false, founder = "", whoComplete = false;
    const masks = new Set<string>();
    const accounts = new Set<string>();
    const reply = client.waitFor((message) => {
      if (message.command === "PONG" && message.params.at(-1) === token) return true;
      if (fold(message.params[0] || "") !== recipient) return false;
      if (fold(message.params[1] || "") === target) {
        if (message.command === "324") {
          const modes = message.params[2] || "";
          privateMode = modes.startsWith("+") && modes.includes("s") && modes.includes("i");
        } else if (message.command === "346") masks.add(fold(message.params[2] || ""));
        else if (message.command === "347") listComplete = true;
        else if (message.command === "315") whoComplete = true;
      }
      if (message.command === "354" && message.params[1] === WHO_TOKEN) accounts.add(fold(message.params[3] || "0"));
      if (message.command === "NOTICE" && fold(message.prefix?.split("!", 1)[0] || "") === "chanserv") {
        const notice = fold(message.params.at(-1) || "");
        if (notice === `channel ${target} is registered`) registered = true;
        if (registered && notice.startsWith("founder: ")) founder = notice.slice(9);
      }
      return false;
    });
    client.send(`MODE ${channel}`);
    client.send(`SAMODE ${channel} +I`);
    client.send(`PRIVMSG ChanServ :INFO ${channel}`);
    client.send(`WHO ${channel} %tna,${WHO_TOKEN}`);
    client.send(`PING ${token}`);
    const confirmed = await Promise.race([
      reply.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now())); }),
    ]);
    // Ergo canonicalizes bare nick invite exceptions to nick!*@*.
    const people = new Set(members.map((nick) => fold(nick)));
    const allowedAccounts = new Set([...people, ...appAccounts()]);
    const allowedMasks = new Set([...people, "slirc"].map((nick) => `${nick}!*@*`));
    return confirmed && privateMode && listComplete && registered && whoComplete
      && people.has(founder)
      && [...people].every((member) => masks.has(`${member}!*@*`))
      && [...masks].every((mask) => allowedMasks.has(mask))
      && [...accounts].every((account) => allowedAccounts.has(account));
  } catch { return false; }
  finally {
    clearTimeout(timer);
    client?.disconnect();
  }
}

// Thread children. Differs from createChannel in three safety-critical ways:
//  1. Ownership is proven before the channel is modified. The oper joins with the no-op path
//     (`join(channel, false)`: SAJOIN only, never withOper's default SAMODE +o), then NAMES must
//     name our own nick *with op* (@/&/~) in a reply scoped to this exact channel. Isolated Ergo
//     opps the oper that SAJOINs a fresh channel, so a scoped reply without @self is not our fresh
//     channel: the helper PARTs and fails without ever sending SAMODE or REGISTER. If anyone else
//     is present, this is a pre-existing (or raced) room, so it is left untouched and we fail.
//  2. ChanServ REGISTER is the registration gate. Its "already registered" reply refuses adoption
//     before any channel mode change, so a pre-existing registered room is left untouched. The
//     secret lock (+si / +R) is applied immediately after REGISTER succeeds, before the TRANSFER await.
//  3. Anyone who slipped in during the REGISTER await is now on a channel we own, so a second NAMES
//     evicts them before transfer; no uninvited occupant survives provisioning.
// On failure the error carries `registered: true` only after our own REGISTER succeeded (so the
// caller may unregister what it created) and `uncertain: true` when a service round trip timed out
// (so the caller keeps its reservation and fails closed rather than retrying blind).
export async function createThreadChannel(channel: string, owner: string, visibility: "workspace" | "secret", members: string[]): Promise<void> {
  await withOper(async (client, join) => {
    // No op. Granting +o before ownership is proven would itself modify a pre-existing room.
    join(channel, false);
    let registered = false;
    let uncertain = false;
    const self = client.nick.toLowerCase();
    // NAMES scoped to exactly this channel: 353 must carry this channel and 366 must close it. A
    // bare 366, an empty list, or an unrelated channel proves nothing, and our own nick must be
    // present (status prefixes kept so we can tell whether Ergo already opped us).
    const names = async (timeoutMs = NAMES_TIMEOUT_MS): Promise<{ present: string[]; selfOp: boolean }> => {
      const target = channel.toLowerCase();
      const present = new Set<string>();
      let selfSeen = false;
      let selfOp = false;
      const reply = client.waitFor((message) => {
        if (message.command === "353") {
          if ((message.params[2] || "").toLowerCase() !== target) return false;
          for (const token of (message.params[3] || "").split(" ")) {
            const prefix = token.match(/^[~&@%+]+/)?.[0] || "";
            const nick = token.slice(prefix.length);
            if (!nick) continue;
            present.add(nick.toLowerCase());
            if (nick.toLowerCase() === self) { selfSeen = true; if (/[@&~]/.test(prefix)) selfOp = true; }
          }
          return false;
        }
        if (message.command === "366") return (message.params[1] || "").toLowerCase() === target;
        return false;
      });
      client.send(`NAMES ${channel}`);
      if (!await Promise.race([reply.then(() => true), sleep(timeoutMs).then(() => false)])) {
        throw Object.assign(new Error(`NAMES for ${channel} got no channel-scoped reply`), { uncertain: true });
      }
      if (!selfSeen) throw Object.assign(new Error(`NAMES for ${channel} did not list ${client.nick}; refusal`), { uncertain: false });
      return { present: [...present], selfOp };
    };
    try {
      let proof: { present: string[]; selfOp: boolean };
      try {
        proof = await names();
      } catch (error) {
        uncertain = !!(error as { uncertain?: boolean }).uncertain; // a scoped reply that omits us is conclusive
        throw error;
      }
      if (proof.present.some((nick) => nick !== self && nick !== "slirc")) {
        throw Object.assign(new Error(`channel ${channel} already has members; refusing to take it over`), { registered: false, uncertain: false });
      }
      // Ergo opps the oper that SAJOINs a fresh channel (proved on isolated Ergo), so a scoped NAMES
      // reply without our own @/&/~ means this is not our fresh channel. Fail and PART; never op
      // ourselves (that write is the modification we must not make on someone else's room), and never
      // reach REGISTER.
      if (!proof.selfOp) {
        throw Object.assign(new Error(`NAMES for ${channel} does not show ${client.nick} opped; refusal`), { registered: false, uncertain: false });
      }

      let notice = "";
      try {
        notice = await serviceCommand(client, "ChanServ", `REGISTER ${channel}`, /successfully registered|already registered/i);
      } catch (error) {
        // A timeout after the command was sent may still have applied it; a conclusive error reply did not.
        if (error instanceof Error && /no reply/.test(error.message)) uncertain = true;
        throw error;
      }
      if (/already registered/i.test(notice)) throw Object.assign(new Error(`channel ${channel} is already registered; refusing to adopt it`), { registered: false, uncertain: false });
      registered = true;

      // We own it now (NAMES proved @self on a fresh channel), so the lock and the grants cannot
      // touch anyone else's room.
      client.send(`SAMODE ${channel} ${visibility === "secret" ? "+si-Rt" : "+R-sit"}`);
      // Ten grants per line: Ergo fakelag spaces the oper's lines about 0.5s apart, and one line per
      // member pushed the NAMES below past its window once a parent had 13 members.
      const invites = [...members, "slirc", client.nick];
      for (let i = 0; i < invites.length; i += 10) {
        const batch = invites.slice(i, i + 10);
        client.send(`SAMODE ${channel} +${"I".repeat(batch.length)} ${batch.join(" ")}`);
      }
      // Anyone who joined during the REGISTER await is an uninvited occupant of our channel.
      const allowed = new Set([self, "slirc", ...members.map((nick) => nick.toLowerCase())]);
      try {
        for (const nick of (await names(NAMES_BURST_TIMEOUT_MS)).present) if (!allowed.has(nick)) client.send(`KICK ${channel} ${nick} :Private thread`);
      } catch (error) {
        uncertain = true;
        throw error;
      }
      await transferChannel(client, channel, owner);
    } catch (error) {
      client.send(`PART ${channel}`);
      forgetChannel(channel);
      throw Object.assign(error instanceof Error ? error : new Error("thread channel setup failed"), { registered, uncertain });
    }
  });
}

// Thrown when a caller-supplied guard proves the requester lost moderation access mid-flight.
// server.ts maps it to 403; every other redaction failure is an honest 500/uncertain outcome.
export class NotAuthorizedError extends Error {}

// Native moderation delete. The configured resident oper has either the `history` cap (delete any
// message) or `samode` + channel op (`allow-individual-delete`), so no human credential is exposed.
// Ergo only echoes REDACT to channel members that negotiated draft/message-redaction, so the oper
// joins the channel first. MODE is a read-only existence probe: SAJOIN against a channel Ergo no
// longer has would create an empty foreign room, which moderation must never do.
//
// Resolves only after Ergo echoes the exact (channel, msgid) back. Any other FAIL, a timeout, or a dropped
// socket all reject, and the caller must report that honestly rather than claim the old message is
// gone (the redaction may or may not have applied).
const MSGID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
// Resolves "gone" when Ergo no longer holds the message (FAIL REDACT UNKNOWN_MSGID): already deleted,
// or its history was reset. The caller treats that as a completed delete.
export async function redactMessage(channel: string, msgid: string, clientId?: string, guard?: () => boolean): Promise<"redacted" | "gone"> {
  if (!/^#[a-z0-9][a-z0-9_-]{0,62}$/i.test(channel)) throw new Error("invalid channel");
  if (!MSGID_SAFE.test(msgid)) throw new Error("invalid msgid");
  if (clientId !== undefined && !MSGID_SAFE.test(clientId)) throw new Error("invalid correlation id");
  const user = serviceNick();
  const password = operPassword();
  const nick = `${user.slice(0, 20)}-${randomBytes(3).toString("hex")}`;
  const client = new IrcClient({
    host: host(), port: port(), nick, realname: "Slirc app", saslUser: user, saslPass: password,
    capabilities: ["draft/message-redaction"],
  });
  try {
    await client.connect();
    let failure = "";
    const loggedIn = client.waitFor((m) => {
      if (m.command === "381") return true;
      if (m.command === "464" || m.command === "491") { failure = m.params.at(-1) || m.command; return true; }
      return false;
    });
    // Mirror operClient: an always-on oper account would reattach and answer OPER with silence.
    client.send("NS SET ALWAYS-ON false");
    client.send(`OPER ${user} ${password}`);
    if (!await Promise.race([loggedIn.then(() => !failure), sleep(2_500).then(() => false)])) {
      throw new Error(`OPER failed: ${failure || "no reply from Ergo"}`);
    }

    let exists: boolean | undefined;
    const probe = client.waitFor((m) => {
      const target = (m.params[1] || "").toLowerCase();
      if (target !== channel.toLowerCase()) return false;
      if (m.command === "324") { exists = true; return true; }
      if (m.command === "403") { exists = false; return true; }
      return false;
    });
    client.send(`MODE ${channel}`);
    if (!await Promise.race([probe.then(() => true), sleep(2_500).then(() => false)])) {
      throw new Error(`could not confirm channel ${channel} exists`);
    }
    if (!exists) throw new Error(`channel ${channel} does not exist`);

    const joined = client.waitFor((m) => m.command === "JOIN" && (m.params[0] || "").toLowerCase() === channel.toLowerCase());
    client.send(`SAJOIN ${client.nick} ${channel}`);
    client.send(`SAMODE ${channel} +o ${client.nick}`);
    if (!await Promise.race([joined.then(() => true), sleep(2_500).then(() => false)])) {
      throw new Error(`could not join ${channel} for moderation`);
    }

    if (guard && !guard()) throw new NotAuthorizedError("moderation access changed");

    let ack = false;
    let gone = false;
    const confirmed = client.waitFor((m) => {
      if (m.command === "REDACT" && (m.params[0] || "").toLowerCase() === channel.toLowerCase() && m.params[1] === msgid) {
        ack = true;
        return true;
      }
      if (m.command === "FAIL" && (m.params[0] || "").toUpperCase() === "REDACT" && (m.params[2] || "").toLowerCase() === channel.toLowerCase()) {
        gone = m.params[1] === "UNKNOWN_MSGID" && m.params[3] === msgid;
        failure = m.params.slice(1).join(" ") || "REDACT failed";
        return true;
      }
      return false;
    });
    const timeout = Number(process.env.REDACT_TIMEOUT_MS || 5_000);
    client.send(`${clientId ? `@+slirc/cid=${clientId} ` : ""}REDACT ${channel} ${msgid}`);
    if (!await Promise.race([confirmed.then(() => true), sleep(timeout).then(() => false)]) || !ack) {
      if (gone) return "gone";
      throw new Error(failure || `REDACT ${channel} ${msgid} was not confirmed`);
    }
    return "redacted";
  } finally {
    client.quit();
  }
}

export async function kickChannelMember(channel: string, nick: string, reason: string): Promise<void> {
  await withOper(async (client, join) => {
    join(channel);
    client.send(`KICK ${channel} ${nick} :${reason}`);
  });
}

// Removing a person: kick them from every channel they were in and drop their invite exception,
// then try to suspend the Ergo account. Suspension disconnects every session, always-on included,
// and refuses new logins; it needs the `ban` oper capability, so an oper class without it only gets
// the kicks (the caller also rotates the password and drops certificates). NS SUSPEND DEL undoes it.
export async function removeMemberFromIrc(nick: string, channels: string[]): Promise<{ suspended: boolean }> {
  return withOper(async (client, join) => {
    for (const channel of channels) {
      join(channel);
      client.send(`KICK ${channel} ${nick} :Removed by an admin`);
      client.send(`SAMODE ${channel} -I ${nick}`);
    }
    try {
      await serviceCommand(client, "NickServ", `SUSPEND ADD ${nick} Removed by an admin`, /successfully suspended/i);
      return { suspended: true };
    } catch (error) {
      console.error(`suspend ${nick}:`, error instanceof Error ? error.message : error);
      return { suspended: false };
    }
  });
}

export async function makeChannelSecret(channel: string, members: string[]): Promise<void> {
  await withOper(async (client) => {
    client.send(`SAMODE ${channel} +si-R`);
    for (const member of members) client.send(`SAMODE ${channel} +I ${member}`);
    client.send(`SAMODE ${channel} +I slirc`);
  });
}

// Reverse of makeChannelSecret. Invite exceptions stay; they are harmless once +i is gone.
export async function makeChannelOpen(channel: string): Promise<void> {
  await withOper(async (client) => { client.send(`SAMODE ${channel} +R-si`); });
}

// A person leaving a channel leaves its threads too: KICK ends their join, and on a private child
// -I drops the invite exception that would let them JOIN again and page the history.
export async function removeFromThreadChannels(nick: string, children: { channel: string; revoke: boolean }[], reason: string): Promise<void> {
  if (!children.length) return;
  await withOper(async (client, join) => {
    for (const child of children) {
      join(child.channel);
      client.send(`KICK ${child.channel} ${nick} :${reason}`);
      if (child.revoke) client.send(`SAMODE ${child.channel} -I ${nick}`);
    }
  });
}

// Locks thread children the way makeChannelSecret locks their parent, then removes whoever is
// sitting in a child without being one of `members`. Without the kick, an outsider already joined
// to a once-public thread would keep reading it live.
export async function makeThreadChannelsSecret(children: string[], members: string[]): Promise<void> {
  if (!children.length) return;
  await withOper(async (client, join) => {
    const allowed = new Set([client.nick.toLowerCase(), "slirc", ...members.map((nick) => nick.toLowerCase())]);
    for (const channel of children) {
      join(channel);
      client.send(`SAMODE ${channel} +si-R`);
      const invites = [...members, "slirc"];
      for (let i = 0; i < invites.length; i += 10) {
        const batch = invites.slice(i, i + 10);
        client.send(`SAMODE ${channel} +${"I".repeat(batch.length)} ${batch.join(" ")}`);
      }
      const present: string[] = [];
      const target = channel.toLowerCase();
      const names = client.waitFor((message) => {
        if (message.command === "353" && (message.params[2] || "").toLowerCase() === target) {
          for (const token of (message.params[3] || "").split(" ")) if (token) present.push(token.replace(/^[~&@%+]+/, ""));
        }
        return message.command === "366" && (message.params[1] || "").toLowerCase() === target;
      });
      client.send(`NAMES ${channel}`);
      if (!await Promise.race([names.then(() => true), sleep(2_500).then(() => false)])) throw new Error(`NAMES failed for ${channel}`);
      for (const nick of present) if (!allowed.has(nick.toLowerCase())) client.send(`KICK ${channel} ${nick} :Private thread`);
    }
  });
}

export async function clearChannelAccess(channel: string): Promise<void> {
  await withOper(async (client) => {
    await serviceCommand(client, "ChanServ", `CLEAR ${channel} ACCESS`, /Successfully reset channel access/i);
  });
}

export async function unregisterChannel(channel: string): Promise<void> {
  const members = new Set<string>();
  await withOper(async (client, join) => {
    join(channel, false);
    client.send(`SAMODE ${channel} +q ${client.nick}`);
    const names = client.waitFor((message) => {
      if (message.command === "353") for (const nick of (message.params.at(-1) || "").split(" ")) members.add(nick.replace(/^[~&@%+]+/, ""));
      return message.command === "366";
    });
    client.send(`NAMES ${channel}`);
    if (!await Promise.race([names.then(() => true), sleep(2_500).then(() => false)])) throw new Error(`NAMES failed for ${channel}`);
    client.send(`SAMODE ${channel} +msi`);
    // Thread channels are created by a plain JOIN and never registered with ChanServ; only the teardown is needed.
    const prompt = await serviceCommand(client, "ChanServ", `UNREGISTER ${channel}`, /CS UNREGISTER|not registered/i);
    if (!/not registered/i.test(prompt)) {
      const code = prompt.match(/UNREGISTER\s+\S+\s+(\S+)$/i)?.[1];
      if (!code) throw new Error("ChanServ UNREGISTER failed: confirmation code missing");
      await serviceCommand(client, "ChanServ", `UNREGISTER ${channel} ${code}`, /is now unregistered/i);
    }
    for (const nick of members) if (nick && nick !== client.nick) client.send(`KICK ${channel} ${nick} :Channel deleted`);
    client.send(`PART ${channel}`);
    forgetChannel(channel);
  });
}

// Clear one channel's Ergo history while it still exists. Uses a throwaway oper connection with the
// CHATHISTORY capabilities (the shared session is not negotiated for history and must not be left
// on a channel we are about to destroy). Best effort: logs and returns a partial result, never
// throws, so a history failure cannot block the teardown.
//
// The purge connection's own membership is the last source of rows: the JOIN is in the scan, and the
// PART event is captured through echo-message and deleted after leaving (HistServ DELETE works
// unjoined). A client that PARTs before QUIT leaves no channel QUIT row, so the channel ends empty.
export async function purgeChannelHistory(channel: string): Promise<ChannelHistoryResult> {
  const failedResult: ChannelHistoryResult = { channel, scanned: 0, deleted: 0, failed: 0, skipped: 0, partial: true };
  if (!validHistoryChannel(channel)) { console.error(`history purge skipped for invalid channel ${JSON.stringify(channel)}`); return failedResult; }
  let client: IrcClient | null = null;
  try {
    client = await operClient(["draft/chathistory", "batch", "message-tags", "server-time", "echo-message", "draft/event-playback"]);
    const joined = await joinHistoryChannel(client, channel);
    const result = await clearChannelHistory(client, channel, { deadlineMs: 15_000 });
    if (!joined) result.partial = true;
    // Capture our own PART echo so its history row can be removed; then QUIT (no row after PART).
    let partMsgid = "";
    const self = client.nick.toLowerCase();
    const target = channel.toLowerCase();
    const parted = client.waitFor((m) => {
      if (m.command !== "PART" || (m.params[0] || "").toLowerCase() !== target) return false;
      if ((m.prefix?.split("!")[0] || "").toLowerCase() !== self) return false;
      partMsgid = m.tags.msgid || "";
      return true;
    });
    client.send(`PART ${channel}`);
    await Promise.race([parted, sleep(2_000)]);
    if (partMsgid) {
      const reply = await deleteHistoryMsgid(client, channel, partMsgid, 3_000);
      if (reply) result.deleted++;
      else { result.failed++; result.partial = true; }
    }
    if (result.partial || result.failed) console.error(`history purge incomplete for ${channel}: scanned=${result.scanned} deleted=${result.deleted} failed=${result.failed}`);
    return result;
  } catch (error) {
    console.error(`history purge failed for ${channel}:`, error);
    return failedResult;
  } finally {
    client?.quit();
  }
}

// Ergo refuses RENAME for channels with persistent history (every registered channel here), so a rename is
// a fresh registration under the new name plus the old one torn down. Ergo-side history does not carry over.
export async function renameChannel(from: string, to: string, owner: string, visibility: "workspace" | "secret", members: string[], topic: string): Promise<void> {
  await createChannel(to, owner, visibility);
  for (const nick of members) if (nick !== owner) await grantChannelAccess(to, nick);
  if (topic) await setChannelTopic(to, topic);
  await unregisterChannel(from);
}

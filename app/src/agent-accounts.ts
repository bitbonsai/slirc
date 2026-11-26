import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { revokeChannelAccess, unregisterChannel } from "./grants.ts";
import { IrcClient, type IrcOptions, type ParsedMessage } from "./irc.ts";

export type AgentIrcClient = Pick<IrcClient, "connect" | "send" | "waitFor" | "quit">;
export type AgentIrcClientFactory = (options: IrcOptions) => AgentIrcClient;

const host = () => process.env.ERGO_HOST || "127.0.0.1";
const port = () => Number(process.env.ERGO_PORT || 6667);
const defaultClientFactory: AgentIrcClientFactory = (options) => new IrcClient(options);
let agentIrcClientFactory = defaultClientFactory;

export function setAgentIrcClientFactoryForTests(factory = defaultClientFactory): void {
  agentIrcClientFactory = factory;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5_000); });
  try { return await Promise.race([promise, expiry]); }
  finally { clearTimeout(timer!); }
}

function nickServNotice(message: ParsedMessage): string {
  return message.command === "NOTICE" && /^NickServ(?:!|$)/i.test(message.prefix || "") ? message.params.at(-1) || "" : "";
}

export function nickServConfirmationCode(text: string, command: "UNREGISTER" | "ERASE", nick: string): string | null {
  const escapedNick = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`/NS\\s+${command}\\s+${escapedNick}\\s+(\\S+)`, "i"))?.[1] || null;
}

export async function rotateAgentPassword(nick: string, currentPassword: string, newPassword: string, factory = agentIrcClientFactory): Promise<boolean> {
  const client = factory({ host: host(), port: port(), nick: "agent-password", realname: "agent password rotation", saslUser: nick, saslPass: currentPassword });
  try {
    try {
      await client.connect();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SASL login failed")) return false;
      throw error;
    }
    let notice = "";
    const reply = client.waitFor((message) => {
      const text = nickServNotice(message);
      if (!text || !/password/i.test(text)) return false;
      notice = text;
      return true;
    });
    client.send(`PRIVMSG NickServ :PASSWD ${currentPassword} ${newPassword} ${newPassword}`);
    await withTimeout(reply, "NickServ password change timed out");
    if (!/^Password changed$/i.test(notice)) throw new Error(`NickServ password change failed: ${notice}`);
    return true;
  } finally {
    client.quit();
  }
}

// NickServ's answer when the account is not there. Removal treats it as done.
const MISSING_ACCOUNT = /^(Invalid account name|No such account)/i;

async function twoStepRemoval(client: AgentIrcClient, command: "UNREGISTER" | "ERASE", nick: string): Promise<void> {
  let code = "";
  let missing = false;
  const challenge = client.waitFor((message) => {
    const text = nickServNotice(message);
    if (MISSING_ACCOUNT.test(text)) return missing = true;
    code = nickServConfirmationCode(text, command, nick) || "";
    return !!code;
  });
  client.send(`PRIVMSG NickServ :${command} ${nick}`);
  await withTimeout(challenge, `NickServ ${command.toLowerCase()} confirmation timed out`);
  if (missing) return;

  let notice = "";
  const result = client.waitFor((message) => {
    const text = nickServNotice(message);
    if (!text || !/unregistered|error|invalid|insufficient/i.test(text)) return false;
    notice = text;
    return true;
  });
  client.send(`PRIVMSG NickServ :${command} ${nick} ${code}`);
  await withTimeout(result, `NickServ ${command.toLowerCase()} timed out`);
  if (MISSING_ACCOUNT.test(notice)) return;
  if (!/^Successfully unregistered account /i.test(notice)) throw new Error(`NickServ ${command.toLowerCase()} failed: ${notice}`);
}

export async function unregisterAgent(nick: string, password: string, factory = agentIrcClientFactory): Promise<void> {
  const client = factory({ host: host(), port: port(), nick: "agent-remove", realname: "agent removal", saslUser: nick, saslPass: password });
  try {
    try {
      await client.connect();
    } catch (error) {
      // Without oper rights a missing account and a stale password look the same. Either way the
      // stored password is all there is, so nothing more can be done in Ergo; local removal goes on.
      if (error instanceof Error && error.message.startsWith("SASL login failed")) {
        console.warn(`agent removal: ${nick} could not log in to Ergo, treating the IRC account as gone: ${error.message}`);
        return;
      }
      throw error;
    }
    await twoStepRemoval(client, "UNREGISTER", nick);
  } finally {
    client.quit();
  }
}

export async function eraseAgentAsOper(nick: string, operUser: string, operPass: string, factory = agentIrcClientFactory): Promise<void> {
  // SASL as the oper account: with require-sasl on, Ergo drops a connection that does not log in
  // before registration, and the removal failed with "IRC connection closed". The nick must
  // differ from the oper name, or Ergo ignores OPER (see grants.ts operClient).
  const client = factory({
    host: host(), port: port(), nick: `${operUser.slice(0, 20)}-${randomBytes(3).toString("hex")}`, realname: "agent erasure",
    saslUser: operUser, saslPass: operPass,
  });
  try {
    await client.connect();
    // Mirror operClient: an always-on oper account would reattach and answer OPER with silence.
    client.send("NS SET ALWAYS-ON false");
    const oper = withTimeout(Promise.race([
      client.waitFor((message) => message.command === "381").then(() => true),
      client.waitFor((message) => message.command === "464" || message.command === "491").then(() => false),
    ]), "OPER timed out");
    client.send(`OPER ${operUser} ${operPass}`);
    if (!await oper) throw new Error("OPER failed: bad oper credentials");
    await twoStepRemoval(client, "ERASE", nick);
  } finally {
    client.quit();
  }
}

export async function removeAgentAccount(
  nick: string,
  password: string,
  channels: string[],
  operations: {
    revoke: typeof revokeChannelAccess;
    unregisterDirect?: typeof unregisterChannel;
    deleteMemberships: (account: string) => void;
    deleteDirects?: (channels: string[]) => void;
    unregister: typeof unregisterAgent;
    erase: typeof eraseAgentAsOper;
    deleteAccount: (account: string) => void;
  } = {
    revoke: revokeChannelAccess,
    unregisterDirect: unregisterChannel,
    deleteMemberships: (account) => { db.query("DELETE FROM channel_members WHERE nick = ?").run(account); },
    deleteDirects: (directs) => {
      for (const channel of directs) {
        db.query("DELETE FROM direct_conversations WHERE channel = ?").run(channel);
        db.query("DELETE FROM threads WHERE channel = ? OR parent = ?").run(channel, channel);
        db.query("DELETE FROM channels WHERE channel = ?").run(channel);
        db.query("DELETE FROM channel_members WHERE channel = ?").run(channel);
      }
    },
    unregister: unregisterAgent,
    erase: eraseAgentAsOper,
    deleteAccount: (account) => { db.query("DELETE FROM accounts WHERE nick = ?").run(account); },
  },
): Promise<void> {
  const directs = channels.filter((channel) => channel.toLowerCase().startsWith("#dm-"));
  const threads = directs.flatMap((channel) => (db.query("SELECT channel FROM threads WHERE parent = ?").all(channel) as { channel: string }[]).map((row) => row.channel));
  for (const channel of [...threads, ...directs]) await operations.unregisterDirect?.(channel);
  for (const channel of channels) if (!directs.includes(channel)) await operations.revoke(channel, nick);
  operations.deleteMemberships(nick);
  operations.deleteDirects?.([...threads, ...directs]);
  const operUser = process.env.ERGO_OPER_USER;
  const operPass = process.env.ERGO_OPER_PASS;
  if (operUser && operPass) await operations.erase(nick, operUser, operPass);
  else await operations.unregister(nick, password);
  operations.deleteAccount(nick);
}

import { randomUUID } from "node:crypto";
import { IrcClient, type ParsedMessage } from "../../shared/irc.ts";
import { reactionLine } from "../../shared/reactions.ts";
import type { Credentials } from "./credentials.ts";
import { isPrivateHost } from "./host.ts";

// Shared between the one-shot commands and the resident session: how to reach Slirc over IRC and HTTP.

export const capabilities = ["server-time", "message-tags", "account-tag", "batch", "draft/chathistory", "draft/multiline"];

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function timeout<T>(promise: Promise<T>, message: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CliError(message)), ms); }),
  ]).finally(() => clearTimeout(timer!));
}

export function webOrigin(host: string): string {
  return `${isPrivateHost(host) ? "http" : "https"}://${host}`;
}

export function ircHost(host: string): string {
  return new URL(webOrigin(host)).hostname;
}

export function nickOf(prefix = ""): string {
  return prefix.split("!", 1)[0];
}

function authHeader(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.nick}:${credentials.password}`).toString("base64")}`;
}

export async function connected(credentials: Credentials, onMessage?: (message: ParsedMessage) => void, onClose?: () => void): Promise<IrcClient> {
  // Loopback dev stacks expose plaintext 6667; a dev stack on a private IP has TLS on 6697 with a
  // self-signed certificate; real hosts get TLS on 6697 and a proper certificate.
  const loopback = /^(localhost|127\.0\.0\.1)(:|$)/.test(credentials.host);
  const client = new IrcClient({
    host: ircHost(credentials.host),
    port: loopback ? 6667 : 6697,
    tls: !loopback,
    tlsInsecure: process.env.SLIRC_TLS_INSECURE === "1" || (!loopback && isPrivateHost(credentials.host)),
    nick: credentials.nick,
    realname: "Slirc agent",
    saslUser: credentials.nick,
    saslPass: credentials.password,
    capabilities,
    onMessage,
    onClose,
  });
  try {
    await timeout(client.connect(), "IRC connection timed out");
  } catch (error) {
    client.quit();
    if (error instanceof Error && error.message.startsWith("SASL login failed")) throw new CliError("Slirc authentication failed. Pair again.", 3);
    throw error;
  }
  return client;
}

export async function join(client: IrcClient, room: string, nick: string): Promise<void> {
  if (!/^[#&]/.test(room)) return; // direct message target: nothing to join
  let failure = "";
  const joined = client.waitFor((message) => {
    if (message.command === "JOIN" && nickOf(message.prefix).toLowerCase() === nick.toLowerCase() && message.params.at(-1)?.toLowerCase() === room.toLowerCase()) return true;
    if (["403", "405", "471", "473", "474", "475", "476", "477", "489"].includes(message.command) && message.params.includes(room)) {
      failure = message.params.at(-1) || message.command;
      return true;
    }
    return false;
  });
  client.send(`JOIN ${room}`);
  await timeout(joined, `Timed out joining ${room}`);
  if (failure) throw new CliError(`Could not join ${room}: ${failure}`);
}

// One PRIVMSG, or a draft/multiline batch when the text has line breaks.
export function sendText(client: IrcClient, room: string, text: string): boolean {
  const lines = text.split("\n");
  if (lines.length === 1) return client.send(`PRIVMSG ${room} :${text}`);
  const batch = `m-${randomUUID().slice(0, 8)}`;
  if (!client.send(`BATCH +${batch} draft/multiline ${room}`)) return false;
  for (const line of lines) if (!client.send(`@batch=${batch} PRIVMSG ${room} :${line}`)) return false;
  return client.send(`BATCH -${batch}`);
}

// Eyes on the message the moment it arrives, so every IRCv3 client sees the acknowledgement.
export function acknowledge(client: IrcClient, room: string, msgid: string): boolean {
  return client.send(reactionLine(room, msgid, "\u{1F440}"));
}

// Rooms the server granted us (DM pair channels, invites) that never produced a live INVITE.
export async function grantedRooms(credentials: Credentials): Promise<string[]> {
  try {
    const response = await fetch(`${webOrigin(credentials.host)}/api/agent/rooms`, { headers: { Authorization: authHeader(credentials) }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return [];
    const body = await response.json() as { rooms?: unknown };
    return Array.isArray(body.rooms) ? body.rooms.filter((room): room is string => typeof room === "string") : [];
  } catch {
    return [];
  }
}

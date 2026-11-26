import { randomBytes } from "node:crypto";
import { operClient } from "./grants.ts";
import { IrcClient, type IrcOptions, type ParsedMessage } from "./irc.ts";

export type CertificateIrcClient = Pick<IrcClient, "connect" | "send" | "waitFor" | "quit">;
type AccountClientFactory = (options: IrcOptions) => CertificateIrcClient;
type OperClientFactory = () => Promise<CertificateIrcClient>;

const host = () => process.env.ERGO_HOST || "127.0.0.1";
const port = () => Number(process.env.ERGO_PORT || 6667);
const defaultAccountClientFactory: AccountClientFactory = (options) => new IrcClient(options);
const defaultOperClientFactory: OperClientFactory = operClient;
let accountClientFactory = defaultAccountClientFactory;
let operClientFactory = defaultOperClientFactory;

export function setCertificateIrcClientFactoriesForTests(
  accountFactory = defaultAccountClientFactory,
  operFactory = defaultOperClientFactory,
): void {
  accountClientFactory = accountFactory;
  operClientFactory = operFactory;
}

export function normalizeCertificateFingerprint(value: string): string | null {
  const fingerprint = value.trim().replace(/^sha256\s+fingerprint\s*=\s*/i, "").replaceAll(":", "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
}

function nickServNotice(message: ParsedMessage): string {
  return message.command === "NOTICE" && /^NickServ(?:!|$)/i.test(message.prefix || "") ? message.params.at(-1) || "" : "";
}

const rejected = /^(?:Account does not exist|An error occurred|Insufficient privileges|Invalid certificate fingerprint|That certificate fingerprint is already associated with another account|Try again later|You already have too many certificate fingerprints|Your account credentials are managed externally)/i;
const accepted = /^(?:Certificate fingerprint successfully (?:added|removed)|That certificate fingerprint was already authorized|Certificate fingerprint not found)$/i;

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("NickServ CERT timed out")), 5_000); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer!); }
}

type CertificateResult = { accepted: boolean; fingerprints: string[]; notice: string };

async function certificateCommand(client: CertificateIrcClient, command: string): Promise<CertificateResult> {
  let notice = "";
  let count: number | null = null;
  const fingerprints: string[] = [];
  const reply = client.waitFor((message) => {
    const text = nickServNotice(message);
    if (!text) return false;
    notice = text;
    const heading = text.match(/^There are (\d+) certificate fingerprint\(s\) authorized for account /i);
    if (heading) count = Number(heading[1]);
    const row = text.match(/^\d+: ([a-f0-9]{64})$/i);
    if (row) fingerprints.push(row[1].toLowerCase());
    return accepted.test(text) || rejected.test(text) || (count !== null && fingerprints.length >= count);
  });
  client.send(`PRIVMSG NickServ :CERT ${command}`);
  await withTimeout(reply);
  return { accepted: accepted.test(notice) || count !== null, fingerprints, notice };
}

async function runCertificateCommand(account: string, password: string, selfCommand: string, operCommand: string): Promise<CertificateResult> {
  const client = accountClientFactory({
    host: host(),
    port: port(),
    nick: `cert-${randomBytes(4).toString("hex")}`,
    realname: "Slirc certificate management",
    saslUser: account,
    saslPass: password,
  });
  let result: CertificateResult | null = null;
  try {
    await client.connect();
    result = await certificateCommand(client, selfCommand);
  } catch {
    // Ergo drops the connection when the account cannot log in, e.g. suspended while an admin
    // removes the person. The oper syntax below still manages a suspended account's certificates.
  } finally {
    client.quit();
  }
  if (result?.accepted) return result;

  const privileged = await operClientFactory();
  try {
    result = await certificateCommand(privileged, operCommand);
  } finally {
    privileged.quit();
  }
  if (!result.accepted) throw new Error(`NickServ CERT failed: ${result.notice || "command refused"}`);
  return result;
}

export async function addCertificate(account: string, password: string, fingerprint: string): Promise<void> {
  await runCertificateCommand(account, password, `ADD ${fingerprint}`, `ADD ${account} ${fingerprint}`);
}

export async function removeCertificate(account: string, password: string, fingerprint: string): Promise<void> {
  await runCertificateCommand(account, password, `DEL ${fingerprint}`, `DEL ${account} ${fingerprint}`);
}

export async function listCertificates(account: string, password: string): Promise<string[]> {
  return (await runCertificateCommand(account, password, "LIST", `LIST ${account}`)).fingerprints;
}

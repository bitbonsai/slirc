import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Credentials = { nick: string; host: string; password: string };
type SecurityRunner = (args: string[], input?: string) => Promise<string>;
type StoreOptions = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; security?: SecurityRunner };

export class NotPairedError extends Error {}

function paths(env: NodeJS.ProcessEnv) {
  const home = env.HOME || homedir();
  return {
    credentials: join(home, ".config", "slirc", "credentials"),
    config: join(home, ".config", "slirc", "config"),
  };
}

async function writePrivate(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotPairedError();
    throw new Error("Stored Slirc credentials are unreadable");
  }
}

const runSecurity: SecurityRunner = (args, input) => new Promise((resolve, reject) => {
  const child = execFile("security", args, { encoding: "utf8" }, (error, stdout) => {
    if (error) reject(new Error("macOS Keychain could not store or read Slirc credentials"));
    else resolve(stdout);
  });
  if (input !== undefined) child.stdin?.end(input);
});

function metadata(value: Record<string, unknown>): { nick: string; host: string } {
  if (typeof value.nick !== "string" || typeof value.host !== "string") throw new Error("Stored Slirc credentials are unreadable");
  return { nick: value.nick, host: value.host };
}

export async function storeCredentials(credentials: Credentials, options: StoreOptions = {}): Promise<void> {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const path = paths(env);
  if (platform === "darwin") {
    // `-w` with no value prompts on the TTY and reads nothing from a pipe. `security -i` reads full commands
    // from stdin instead, so the password never appears in argv or the process list.
    const quote = (value: string) => `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
    await (options.security || runSecurity)(["-i"], `add-generic-password -U -s slirc -a ${quote(credentials.nick)} -w ${quote(credentials.password)}\n`);
    await writePrivate(path.config, { nick: credentials.nick, host: credentials.host });
    return;
  }
  await writePrivate(path.credentials, credentials);
}

export async function loadCredentials(options: StoreOptions = {}): Promise<Credentials> {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const path = paths(env);
  if (platform === "darwin") {
    const saved = metadata(await readJson(path.config));
    const password = (await (options.security || runSecurity)(["find-generic-password", "-s", "slirc", "-a", saved.nick, "-w"])).trimEnd();
    if (!password) throw new NotPairedError();
    return { ...saved, password };
  }
  const saved = await readJson(path.credentials);
  const info = metadata(saved);
  if (typeof saved.password !== "string" || !saved.password) throw new Error("Stored Slirc credentials are unreadable");
  return { ...info, password: saved.password };
}

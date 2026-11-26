import { expect, test } from "bun:test";
import { createIrcPage, normalizeIrcConnection } from "@client/irc-page.ts";

async function check(run: (env: ReturnType<typeof setup>) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  try { await run(setup()); }
  finally { if (saved) Object.defineProperty(globalThis, "fetch", saved); else Reflect.deleteProperty(globalThis, "fetch"); }
}

function setup() {
  const calls: { path: string; method: string; body: any }[] = [];
  let key = "eve-id";
  let responder: (path: string, init?: RequestInit) => Promise<Response> = async () => Response.json({ error: "no response set" }, { status: 500 });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return responder(path, init);
  } });
  const core = { authenticated: true, account: "eve", ircConnection: null as null | { host: string; port: number; tls: boolean; allowSelfSigned: boolean; local: boolean } };
  const page = createIrcPage((value) => value, {
    core,
    session: { scope: () => ({ instance: "https://slirc.example.test", account: "eve", accountId: key }), key: () => key, stopped: () => false, signingOut: () => false },
    nextTick: async (callback?: () => void) => { callback?.(); },
  });
  return { page, core, calls, setKey: (next: string) => { key = next; }, respond: (fn: typeof responder) => { responder = fn; } };
}

test("loads password devices and certificates from the server", () => check(async ({ page, respond }) => {
  respond(async (path) => path === "/api/irc/devices"
    ? Response.json([{ id: "d1", label: "Halloy", createdAt: 1 }])
    : Response.json([{ id: "c1", label: "WeeChat", fingerprint: "aa".repeat(32), createdAt: 2 }]));
  await page.load();
  expect(page.loaded).toBe(true);
  expect(page.devices.map((item) => item.label)).toEqual(["Halloy"]);
  expect(page.certificates.map((item) => item.label)).toEqual(["WeeChat"]);
}));

test("a new password client shows the one-time password and never stores it after reset", () => check(async ({ page, calls, respond, setKey }) => {
  respond(async (path, init) => init?.method === "POST" && path === "/api/irc/devices"
    ? Response.json({ device: { id: "d1", label: "Halloy", createdAt: 1 }, password: "one-time-secret" }, { status: 201 })
    : Response.json([]));
  await page.load();
  page.passwordName = "Halloy";
  await page.addPassword();
  expect(calls.at(-1)).toEqual({ path: "/api/irc/devices", method: "POST", body: { label: "Halloy" } });
  expect(page.password).toBe("one-time-secret");
  expect(page.devices[0]?.label).toBe("Halloy");
  expect(page.passwordName).toBe("");
  expect(page.passwordOpen).toBe(false);
  page.reset(); setKey("another-account");
  expect(page.password).toBe("");
  expect(page.devices).toEqual([]);
}));

test("removing a certificate or a password device targets only that client", () => check(async ({ page, calls, respond }) => {
  respond(async () => new Response(null, { status: 204 }));
  page.certificates = [{ id: "c1", label: "Mac", fingerprint: "aa", createdAt: 1 }];
  page.askRemove({ ids: [{ kind: "certificate", id: "c1" }], label: "Mac" }, {} as HTMLElement);
  await page.confirmRemove();
  expect(calls.at(-1)).toEqual({ path: "/api/irc/certificates/c1", method: "DELETE", body: null });
  expect(page.certificates).toEqual([]);

  respond(async () => Response.json({ password: "rotated-secret" }));
  page.devices = [{ id: "d1", label: "Halloy", createdAt: 1 }];
  page.askRemove({ ids: [{ kind: "device", id: "d1" }], label: "Halloy" }, {} as HTMLElement);
  await page.confirmRemove();
  expect(calls.at(-1)).toEqual({ path: "/api/irc/devices/d1", method: "DELETE", body: null });
  expect(page.devices).toEqual([]);
  expect(page.password).toBe("rotated-secret");
}));

test("a load that finishes after account reset cannot populate the page", () => check(async ({ page, respond, setKey }) => {
  const pending: ((response: Response) => void)[] = [];
  let released = false;
  respond(() => new Promise((resolve) => { if (released) resolve(Response.json([])); else pending.push(resolve); }));
  const loading = page.load();
  page.reset(); setKey("another-account");
  released = true;
  pending.forEach((resolve) => resolve(Response.json([])));
  await loading;
  expect(page.loaded).toBe(false);
  expect(page.devices).toEqual([]);
}));

test("normalizeIrcConnection fails closed and keeps server fields", () => {
  expect(normalizeIrcConnection(null)).toBeNull();
  expect(normalizeIrcConnection({})).toBeNull();
  expect(normalizeIrcConnection({ host: " irc.example.com " })).toEqual({ host: "irc.example.com", port: 6697, tls: true, allowSelfSigned: false, local: false });
  expect(normalizeIrcConnection({ host: "127.0.0.1", port: 6797, tls: true, allowSelfSigned: true, local: true })).toEqual({ host: "127.0.0.1", port: 6797, tls: true, allowSelfSigned: true, local: true });
  expect(normalizeIrcConnection({ host: "x", tls: false })!.tls).toBe(false);
  expect(normalizeIrcConnection({ host: "x", port: -1 })!.port).toBe(6697);
});

test("local isolated metadata yields 127.0.0.1:6797 and the Halloy self-signed exception", () => check(async ({ page, core }) => {
  core.ircConnection = { host: "127.0.0.1", port: 6797, tls: true, allowSelfSigned: true, local: true };
  page.password = "one-time-secret";
  const configs = Object.fromEntries(page.configs().map((config) => [config.name, config.text]));
  expect(page.selfSigned()).toBe(true);
  expect(page.localOnly()).toBe(true);
  expect(page.connectionNote()).toContain("x1 / this machine only");
  expect(configs.Halloy).toContain('server = "127.0.0.1"');
  expect(configs.Halloy).toContain("port = 6797");
  expect(configs.Halloy).toContain("use_tls = true");
  expect(configs.Halloy).toContain("dangerously_accept_invalid_certs = true");
  expect(configs.Halloy).toContain("Do not use this config for production");
  // Correct advertised host/port elsewhere, and no invented certificate bypass for other clients.
  expect(configs.Senpai).toContain("address 127.0.0.1:6797");
  expect(configs.WeeChat).toContain("slirc 127.0.0.1:6797 -ssl");
  expect(configs.Textual).toContain("Port: 6797");
  for (const name of ["Senpai", "WeeChat", "Textual"]) expect(configs[name]).not.toContain("dangerously_accept_invalid_certs");
}));

test("production metadata never emits the local insecure flag, even on a plain-HTTP page", () => check(async ({ page, core }) => {
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "app.slirc.org", protocol: "http:" } });
  try {
    core.ircConnection = { host: "", port: 6697, tls: true, allowSelfSigned: false, local: false };
    page.password = "one-time-secret";
    const halloy = page.configs().find((config) => config.name === "Halloy")!;
    expect(page.selfSigned()).toBe(false);
    expect(page.localOnly()).toBe(false);
    expect(halloy.text).toContain('server = "app.slirc.org"');
    expect(halloy.text).toContain("port = 6697");
    expect(halloy.text).toContain("use_tls = true");
    expect(halloy.text).not.toContain("dangerously_accept_invalid_certs");
    expect(halloy.text).not.toContain("x1 / this machine only");
  } finally {
    if (savedLocation) Object.defineProperty(globalThis, "location", savedLocation); else Reflect.deleteProperty(globalThis, "location");
  }
}));

test("Halloy TOML escapes quotes and backslashes, and reset clears config output", () => check(async ({ page, core, setKey }) => {
  core.ircConnection = { host: "irc.example.com", port: 6697, tls: true, allowSelfSigned: false, local: false };
  core.account = 'ev"e\\x';
  page.password = 'pa"ss\\word';
  const halloy = page.configs().find((config) => config.name === "Halloy")!;
  expect(halloy.text).toContain('nickname = "ev\\"e\\\\x"');
  expect(halloy.text).toContain('password = "pa\\"ss\\\\word"');
  page.reset(); setKey("another-account");
  expect(page.configs()).toEqual([]);
}));

test("tenant workspaces include the workspace name in Halloy and WeeChat server keys", () => check(async ({ page, core }) => {
  core.ircConnection = { host: "calango.slirc.app", port: 6697, tls: true, allowSelfSigned: false, local: false };
  page.password = "one-time-secret";
  const configs = Object.fromEntries(page.configs().map((config) => [config.name, config.text]));
  expect(configs.Halloy).toContain("[servers.slirc-calango]");
  expect(configs.Halloy).toContain("[servers.slirc-calango.sasl.plain]");
  expect(configs.WeeChat).toContain("/server add slirc-calango calango.slirc.app:6697 -ssl");
  expect(configs.WeeChat).toContain("/set irc.server.slirc-calango.sasl_password");
  expect(configs.WeeChat).toContain("/connect slirc-calango");

  core.ircConnection = { host: "app.slirc.org", port: 6697, tls: true, allowSelfSigned: false, local: false };
  const mainConfigs = Object.fromEntries(page.configs().map((config) => [config.name, config.text]));
  expect(mainConfigs.Halloy).toContain("[servers.slirc]");
  expect(mainConfigs.WeeChat).toContain("/server add slirc app.slirc.org:6697 -ssl");
}));

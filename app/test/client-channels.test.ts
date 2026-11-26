import { expect, test } from "bun:test";
import { createChannelsPage } from "@client/channels-page.ts";

async function check(run: (env: ReturnType<typeof setup>) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  try { await run(setup()); }
  finally { if (saved) Object.defineProperty(globalThis, "fetch", saved); else Reflect.deleteProperty(globalThis, "fetch"); }
}

function setup() {
  const calls: { path: string; method: string; body: any }[] = [];
  const opened: string[] = [];
  let connected = 0, key = "eve-id";
  let responder: () => Promise<Response> = async () => Response.json({ error: "no response set" }, { status: 500 });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return responder();
  } });
  const page = createChannelsPage((value) => value, {
    core: { authenticated: true, account: "eve" },
    session: { scope: () => ({ instance: "https://slirc.example.test", account: "eve", accountId: key }), key: () => key, stopped: () => false, signingOut: () => false },
    connect: async () => { connected += 1; },
    openRoom: (room) => { opened.push(room); },
  });
  return { page, calls, opened, connected: () => connected, setKey: (next: string) => { key = next; }, respond: (fn: () => Promise<Response>) => { responder = fn; } };
}

test("creating a channel posts name and visibility, revalidates, then opens the new room", () => check(async ({ page, calls, opened, connected, respond }) => {
  respond(async () => Response.json({ channel: "#watercooler" }, { status: 201 }));
  page.newChannel = " Watercooler "; page.channelVisibility = "workspace";
  await page.createChannel();
  expect(calls).toEqual([{ path: "/api/channels", method: "POST", body: { name: "Watercooler", visibility: "workspace" } }]);
  expect(connected()).toBe(1);
  expect(opened).toEqual(["#watercooler"]);
  expect(page.newChannel).toBe("");
  expect(page.channelBusy).toBe(false);
}));

test("a rejected create surfaces the server error and never routes", () => check(async ({ page, opened, connected, respond }) => {
  respond(async () => Response.json({ error: "That channel already exists." }, { status: 409 }));
  page.newChannel = "help";
  await page.createChannel();
  expect(page.channelError).toBe("That channel already exists.");
  expect(page.channelBusy).toBe(false);
  expect(opened).toEqual([]);
  expect(connected()).toBe(0);
}));

test("a create in flight for another account cannot open a room after reset", () => check(async ({ page, opened, setKey, respond }) => {
  let finish!: (response: Response) => void;
  respond(() => new Promise((resolve) => { finish = resolve; }));
  page.newChannel = "watercooler";
  const creating = page.createChannel();
  page.reset(); setKey("another-account");
  finish(Response.json({ channel: "#watercooler" }, { status: 201 }));
  await creating;
  expect(opened).toEqual([]);
}));

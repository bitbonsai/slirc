import "./fixture.ts";
import { createHash } from "node:crypto";
import { afterEach, expect, mock, test } from "bun:test";

// App-level visibility policy only: the IRC oper calls are recorded instead of sent. This proves
// denial-before-mutation, not what Ergo does with JOIN or history afterwards.
const created: { channel: string; owner: string; visibility: string }[] = [];
const opened: string[] = [];
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
  ...grants,
  createChannel: async (channel: string, owner: string, visibility: "workspace" | "secret") => { created.push({ channel, owner, visibility }); },
  makeChannelOpen: async (channel: string) => { opened.push(channel); },
  makeChannelSecret: async () => {},
}));
const accounts = await import("../src/accounts.ts");
mock.module("../src/accounts.ts", () => ({ ...accounts, ircChannelExists: async () => false }));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");

const token = "visibility-test-session";
const auth = { Cookie: `slirc_session=${token}`, "Content-Type": "application/json" };
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
  .run(createHash("sha256").update(token).digest("hex"), Date.now());

const previousMode = process.env.SLIRC_MODE;
function useMode(mode: "private_workspace" | "public_playground") {
  process.env.SLIRC_MODE = mode;
  created.length = 0;
  opened.length = 0;
}
afterEach(() => {
  process.env.SLIRC_MODE = previousMode;
  db.query("DELETE FROM channels WHERE channel LIKE '#vis-%'").run();
  db.query("DELETE FROM channel_members WHERE channel LIKE '#vis-%'").run();
});

async function createChannel(body: Record<string, unknown>) {
  return app.request("/api/channels", { method: "POST", headers: auth, body: JSON.stringify(body) });
}

test("private mode creates a secret channel when visibility is omitted", async () => {
  useMode("private_workspace");
  const response = await createChannel({ name: "vis-omitted" });
  expect(response.status).toBe(201);
  expect((await response.json()).visibility).toBe("secret");
  expect(created).toEqual([{ channel: "#vis-omitted", owner: "bitbonsai", visibility: "secret" }]);
  expect(db.query("SELECT visibility FROM channels WHERE channel = '#vis-omitted'").get()).toEqual({ visibility: "secret" });
});

test("private mode honours an explicit secret and an explicit workspace", async () => {
  useMode("private_workspace");
  const secret = await createChannel({ name: "vis-secret", visibility: "secret" });
  expect(secret.status).toBe(201);
  expect((await secret.json()).visibility).toBe("secret");
  const workspace = await createChannel({ name: "vis-workspace", visibility: "workspace" });
  expect(workspace.status).toBe(201);
  expect((await workspace.json()).visibility).toBe("workspace");
  expect(created.map((row) => row.visibility)).toEqual(["secret", "workspace"]);
});

test("private mode rejects an unknown explicit visibility before creating anything", async () => {
  useMode("private_workspace");
  for (const visibility of [null, "public", "Secret", 7, true]) {
    const response = await createChannel({ name: "vis-invalid", visibility });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeTruthy();
  }
  expect(created).toEqual([]);
  expect(db.query("SELECT 1 FROM channels WHERE channel LIKE '#vis-%'").get()).toBeNull();
});

test("public mode keeps its existing omitted-visibility default", async () => {
  useMode("public_playground");
  const response = await createChannel({ name: "vis-public" });
  expect(response.status).toBe(201);
  expect((await response.json()).visibility).toBe("workspace");
  expect(created).toEqual([{ channel: "#vis-public", owner: "bitbonsai", visibility: "workspace" }]);
});

function secretChannel(channel: string, visibility = "secret") {
  db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES (?, 'bitbonsai', ?, '', ?)")
    .run(channel, visibility, Date.now());
  db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'bitbonsai')").run(channel);
}

async function patch(channel: string, action: string) {
  return app.request(`/api/channels/${encodeURIComponent(channel)}`, {
    method: "PATCH", headers: auth, body: JSON.stringify({ action }),
  });
}

test("private mode denies opening a secret channel without mutating it", async () => {
  useMode("private_workspace");
  secretChannel("#vis-private");
  const response = await patch("#vis-private", "open");
  expect(response.status).toBe(403);
  expect(opened).toEqual([]);
  expect(db.query("SELECT visibility FROM channels WHERE channel = '#vis-private'").get()).toEqual({ visibility: "secret" });
});

test("private mode still closes a workspace channel and re-confirms a secret one", async () => {
  useMode("private_workspace");
  secretChannel("#vis-closing", "workspace");
  expect((await patch("#vis-closing", "secret")).status).toBe(200);
  expect(db.query("SELECT visibility FROM channels WHERE channel = '#vis-closing'").get()).toEqual({ visibility: "secret" });
  expect((await patch("#vis-closing", "secret")).status).toBe(200);
  expect(db.query("SELECT visibility FROM channels WHERE channel = '#vis-closing'").get()).toEqual({ visibility: "secret" });
});

test("public mode still opens a secret channel", async () => {
  useMode("public_playground");
  secretChannel("#vis-public-open");
  expect((await patch("#vis-public-open", "open")).status).toBe(200);
  expect(opened).toEqual(["#vis-public-open"]);
  expect(db.query("SELECT visibility FROM channels WHERE channel = '#vis-public-open'").get()).toEqual({ visibility: "workspace" });
});

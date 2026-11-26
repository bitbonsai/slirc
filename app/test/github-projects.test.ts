import "./fixture.ts";

import { beforeEach, describe, expect, test, mock } from "bun:test";
import { createHash, createHmac } from "node:crypto";

// The app's side of the feature: channel provisioning and webhook posting are stubbed and
// recorded, so this proves the binding, the signature gate and the message text, not Ergo.
const created: string[] = [];
const posted: { channel: string; text: string }[] = [];
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
  ...grants,
  createChannel: async (channel: string) => { created.push(channel); },
}));
const notes = await import("../src/update-notes.ts");
mock.module("../src/update-notes.ts", () => ({
  ...notes,
  postNote: async (channel: string, text: string) => { posted.push({ channel, text }); },
}));

process.env.IRC_CHANNEL = "#lobby";
const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const projects = await import("../src/github-projects.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
db.query("INSERT OR IGNORE INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('ada', 'ada@example.com', 'member', 'human', 1, 1)").run();
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'ada', ?)").run(sha("ada-session"), Date.now());

const ORIGIN = "https://app.example.test";
const headers = { Cookie: "slirc_session=ada-session" } as Record<string, string>;
const jsonHeaders = { ...headers, Origin: ORIGIN, "Content-Type": "application/json", "X-Slirc-Projects": "1" };
const sign = (secret: string, body: string | Uint8Array) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const bindRepo = (repo: unknown, customHeaders: Record<string, string> = jsonHeaders) =>
  app.request("/api/projects", { method: "POST", headers: customHeaders, body: JSON.stringify({ repo }) });
const listProjects = () => app.request("/api/projects", { headers });
const deliver = (repo: string, event: string, payload: unknown, signature?: string | null, extraHeaders: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  const sent = signature === undefined ? sign("", body) : signature;
  return app.request(`/api/webhooks/github/${repo}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      ...(sent === null ? {} : { "X-Hub-Signature-256": sent }),
      ...extraHeaders,
    },
    body,
  });
};

// A bound project, with its one-time secret, for the webhook tests.
async function project(repo = "acme/rocket") {
  const response = await bindRepo(repo);
  expect(response.status).toBe(201);
  return await response.json() as { channel: string; repo: string; webhookUrl: string; webhookSecret: string };
}

const issue = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  issue: {
    number: 12,
    title: "Login button jumps",
    html_url: "https://github.com/acme/rocket/issues/12",
    user: { login: "octocat" },
    labels: [{ name: "bug" }, { name: "ui" }],
    ...extra,
  },
});
const pull = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  pull_request: {
    number: 7,
    title: "Add radar chart",
    html_url: "https://github.com/acme/rocket/pull/7",
    user: { login: "ada" },
    labels: [],
    ...extra,
  },
});

beforeEach(() => {
  created.length = 0;
  posted.length = 0;
  db.exec("DELETE FROM project_repos; DELETE FROM channels; DELETE FROM channel_members");
});

describe("repo parsing and channel names", () => {
  test("normalizes owner/repo", () => {
    expect(projects.parseRepo("  acme/rocket ")).toEqual({ owner: "acme", name: "rocket" });
    expect(projects.parseRepo("acme")).toBeNull();
    expect(projects.parseRepo("acme/rocket/extra")).toBeNull();
    expect(projects.parseRepo("acme/..")).toBeNull();
    expect(projects.parseRepo("ac me/rocket")).toBeNull();
    expect(projects.parseRepo(42)).toBeNull();
  });

  test("prefers #repo and falls back to #owner-repo, rejecting reserved prefixes", () => {
    expect(projects.channelCandidates({ owner: "Acme", name: "Rocket" })).toEqual(["#rocket", "#acme-rocket"]);
    expect(projects.channelCandidates({ owner: "acme", name: "rocket.chart" })).toEqual(["#rocket-chart", "#acme-rocket-chart"]);
    expect(projects.channelCandidates({ owner: "dm", name: "dm-secret" })).toEqual([]);
    expect(projects.channelCandidates({ owner: "t", name: "t-thread" })).toEqual([]);
    expect(projects.channelCandidates({ owner: "g", name: "g-group" })).toEqual([]);
    expect(projects.channelCandidates({ owner: "acme", name: "dm-secret" })).toEqual(["#acme-dm-secret"]);
  });
});

describe("POST /api/projects", () => {
  test("binds the repo, creates the channel and returns the secret once", async () => {
    const response = await bindRepo("acme/rocket");
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, string>;
    expect(body.channel).toBe("#rocket");
    expect(body.repo).toBe("acme/rocket");
    expect(body.webhookUrl).toContain("/api/webhooks/github/acme/rocket");
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(created).toEqual(["#rocket"]);

    const room = db.query("SELECT owner, visibility FROM channels WHERE channel = '#rocket'").get() as { owner: string; visibility: string };
    expect(room).toEqual({ owner: "ada", visibility: "workspace" });
    expect(db.query("SELECT COUNT(*) AS n FROM channel_members WHERE channel = '#rocket' AND nick = 'ada'").get()).toEqual({ n: 1 });
    const row = db.query("SELECT repo_owner, repo_name, creator_nick, webhook_secret FROM project_repos").get() as Record<string, string>;
    expect(row).toEqual({ repo_owner: "acme", repo_name: "rocket", creator_nick: "ada", webhook_secret: body.webhookSecret });
  });

  test("rejects a second binding for the same repo, whatever the case", async () => {
    await project("acme/rocket");
    const duplicate = await bindRepo("Acme/Rocket");
    expect(duplicate.status).toBe(409);
    expect(created).toEqual(["#rocket"]);
  });

  test("uses #owner-repo when the short name is another room", async () => {
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#rocket', 'bitbonsai', 'workspace', 1)").run();
    const response = await bindRepo("acme/rocket");
    expect(response.status).toBe(201);
    expect((await response.json() as { channel: string }).channel).toBe("#acme-rocket");
    expect(created).toEqual(["#acme-rocket"]);
  });

  test("adopts a workspace channel the caller already owns", async () => {
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#rocket', 'ada', 'workspace', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#rocket', 'ada')").run();
    const response = await bindRepo("acme/rocket");
    expect(response.status).toBe(201);
    expect((await response.json() as { channel: string }).channel).toBe("#rocket");
    expect(created).toEqual([]);
  });

  test("rejects bad input, reserved prefixes, open channels, missing CSRF, oversized body, and signed-out callers", async () => {
    expect((await bindRepo("not-a-repo")).status).toBe(400);
    expect((await bindRepo("dm/dm-secret")).status).toBe(400);
    expect((await bindRepo("t/t-thread")).status).toBe(400);
    expect((await bindRepo("g/g-group")).status).toBe(400);
    // Open channel #help is skipped/never hijacked; falls back to #acme-help.
    const openFallback = await bindRepo("acme/help");
    expect(openFallback.status).toBe(201);
    expect((await openFallback.json() as { channel: string }).channel).toBe("#acme-help");
    expect(db.query("SELECT 1 FROM channels WHERE channel = '#help'").get()).toBeNull();
    db.exec("DELETE FROM project_repos; DELETE FROM channels; DELETE FROM channel_members");

    // Missing CSRF header or Origin returns 403.
    const noCsrf = await bindRepo("acme/rocket", { ...headers, "Content-Type": "application/json" });
    expect(noCsrf.status).toBe(403);

    // Oversized body (>8192 bytes) returns 413.
    const oversized = await app.request("/api/projects", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ repo: "acme/rocket", pad: "x".repeat(9_000) }),
    });
    expect(oversized.status).toBe(413);

    const anonymous = await app.request("/api/projects", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Slirc-Projects": "1" },
      body: JSON.stringify({ repo: "acme/rocket" }),
    });
    expect(anonymous.status).toBe(401);
    expect(db.query("SELECT COUNT(*) AS n FROM project_repos").get()).toEqual({ n: 0 });
  });

  test("rate-limits project creation per account", async () => {
    db.query("INSERT OR IGNORE INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('burst', 'burst@example.com', 'member', 'human', 1, 1)").run();
    db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'burst', ?)").run(sha("burst-session"), Date.now());
    const burstHeaders = { Cookie: "slirc_session=burst-session", Origin: ORIGIN, "Content-Type": "application/json", "X-Slirc-Projects": "1" };
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const res = await bindRepo("not-a-repo", burstHeaders);
      if (res.status === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});

describe("GET /api/projects", () => {
  test("lists bindings without the webhook secret", async () => {
    const bound = await project();
    const response = await listProjects();
    expect(response.status).toBe(200);
    const body = await response.json() as { projects: Record<string, string>[] };
    expect(body.projects).toEqual([{ channel: "#rocket", repo: "acme/rocket", creatorNick: "ada", createdAt: expect.any(String) }]);
    expect(JSON.stringify(body)).not.toContain(bound.webhookSecret);
  });
});

describe("verifyGithubSignature", () => {
  const secret = "s3cret";
  const body = JSON.stringify(issue("opened"));

  test("accepts the matching signature", () => {
    expect(projects.verifyGithubSignature(secret, body, sign(secret, body))).toBe(true);
  });

  test("rejects a wrong secret, an empty secret, a missing header and a tampered body, and supports raw bytes", () => {
    expect(projects.verifyGithubSignature("", body, sign("", body))).toBe(false);
    expect(projects.verifyGithubSignature(secret, body, sign("other", body))).toBe(false);
    expect(projects.verifyGithubSignature(secret, body, "")).toBe(false);
    expect(projects.verifyGithubSignature(secret, body, "sha1=abc")).toBe(false);
    expect(projects.verifyGithubSignature(secret, `${body} `, sign(secret, body))).toBe(false);
    const rawBytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    expect(projects.verifyGithubSignature(secret, rawBytes, sign(secret, rawBytes))).toBe(true);
  });
});

describe("formatGithubEvent", () => {
  test("an opened issue carries number, author, title, labels and URL", () => {
    expect(projects.formatGithubEvent("issues", issue("opened"), "acme/rocket")).toBe(
      "Issue #12 opened by octocat in acme/rocket: Login button jumps\nLabels: bug, ui\nhttps://github.com/acme/rocket/issues/12",
    );
  });

  test("a closed issue says closed", () => {
    expect(projects.formatGithubEvent("issues", issue("closed"), "acme/rocket")).toContain("Issue #12 closed by octocat");
  });

  test("a merged pull request says merged, a plain close says closed", () => {
    expect(projects.formatGithubEvent("pull_request", pull("opened"), "acme/rocket")).toContain("Pull request #7 opened by ada");
    expect(projects.formatGithubEvent("pull_request", pull("closed", { merged: true }), "acme/rocket")).toContain("Pull request #7 merged by ada");
    expect(projects.formatGithubEvent("pull_request", pull("closed", { merged: false }), "acme/rocket")).toContain("Pull request #7 closed by ada");
  });

  test("unsupported events, actions and payloads produce nothing", () => {
    expect(projects.formatGithubEvent("push", pull("opened"), "acme/rocket")).toBeNull();
    expect(projects.formatGithubEvent("issues", issue("labeled"), "acme/rocket")).toBeNull();
    expect(projects.formatGithubEvent("issues", { action: "opened" }, "acme/rocket")).toBeNull();
    expect(projects.formatGithubEvent("issues", null, "acme/rocket")).toBeNull();
  });

  test("a title cannot inject another IRC line", () => {
    const text = projects.formatGithubEvent("issues", issue("opened", { title: "Hi\r\nQUIT :bye" }), "acme/rocket");
    expect(text).not.toContain("\nQUIT");
    expect(text?.split("\n")[0]).toContain("Hi QUIT :bye");
  });
});

describe("POST /api/webhooks/github/:owner/:repo", () => {
  test("posts an issue opened update into the bound channel", async () => {
    const bound = await project();
    const body = JSON.stringify(issue("opened"));
    const response = await deliver("acme/rocket", "issues", issue("opened"), sign(bound.webhookSecret, body));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ posted: true, channel: "#rocket" });
    expect(posted).toEqual([{
      channel: "#rocket",
      text: "Issue #12 opened by octocat in acme/rocket: Login button jumps\nLabels: bug, ui\nhttps://github.com/acme/rocket/issues/12",
    }]);
  });

  test("posts a merged pull request update", async () => {
    const bound = await project();
    const body = JSON.stringify(pull("closed", { merged: true }));
    const response = await deliver("acme/rocket", "pull_request", pull("closed", { merged: true }), sign(bound.webhookSecret, body));
    expect(response.status).toBe(202);
    expect(posted[0].channel).toBe("#rocket");
    expect(posted[0].text).toContain("Pull request #7 merged by ada in acme/rocket: Add radar chart");
    expect(posted[0].text).toContain("https://github.com/acme/rocket/pull/7");
  });

  test("rejects a missing, wrong or tampered signature without posting", async () => {
    const bound = await project();
    const body = JSON.stringify(issue("opened"));
    expect((await deliver("acme/rocket", "issues", issue("opened"), null)).status).toBe(401);
    expect((await deliver("acme/rocket", "issues", issue("opened"), sign("wrong", body))).status).toBe(401);
    expect((await deliver("acme/rocket", "issues", issue("closed"), sign(bound.webhookSecret, body))).status).toBe(401);
    expect(posted).toEqual([]);
  });

  test("ignores unsupported events and unbound repositories", async () => {
    const bound = await project();
    expect((await deliver("acme/rocket", "ping", { zen: "hi" }, sign(bound.webhookSecret, JSON.stringify({ zen: "hi" })))).status).toBe(202);
    expect((await deliver("acme/rocket", "issues", issue("labeled"), sign(bound.webhookSecret, JSON.stringify(issue("labeled"))))).status).toBe(202);
    expect((await deliver("other/repo", "issues", issue("opened"))).status).toBe(404);
    expect(posted).toEqual([]);
  });

  test("deduplicates replayed X-GitHub-Delivery IDs without reposting", async () => {
    const bound = await project();
    const body = JSON.stringify(issue("opened"));
    const sig = sign(bound.webhookSecret, body);
    const first = await deliver("acme/rocket", "issues", issue("opened"), sig, { "X-GitHub-Delivery": "deliv-1" });
    expect(first.status).toBe(202);
    const replay = await deliver("acme/rocket", "issues", issue("opened"), sig, { "X-GitHub-Delivery": "deliv-1" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ duplicate: true });
    expect(posted).toHaveLength(1);
  });

  test("rate-limits webhook bursts per repo", async () => {
    const bound = await project("acme/burst");
    const payload = { zen: "hi" };
    const sig = sign(bound.webhookSecret, JSON.stringify(payload));
    let limited = false;
    for (let i = 0; i < 35; i++) {
      const res = await deliver("acme/burst", "ping", payload, sig);
      if (res.status === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});

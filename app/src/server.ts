import { join } from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { setCookie } from "hono/cookie";
import { serveStatic } from "hono/bun";
import { db } from "./db.ts";
import { assertDirectReadiness } from "./direct-readiness.ts";
import { emojiBudgetBytes, slircMode } from "./config.ts";
import { openDirectConversation } from "./direct.ts";
import { ircKey } from "./irc-key.ts";
import { accountByNick, allAccounts } from "./accounts.ts";
import { sweepExpired } from "./pairing.ts";
import { instanceHost, offeredHarnesses } from "./agent-connect.ts";
import { type Binding } from "./agent-session.ts";
import { ownerAgentRequestStates, syncAgentPresence, connectAgentTransport, resetAgentSessionState } from "./agent-session-transport.ts";
import { subscribe } from "./live.ts";
import { observeReplyLine } from "./reply-threads.ts";
import { handleRelayUpgrade, relayWebsocketHandlers } from "./relay.ts";
import { configuredAppOrigin, isAllowedClientOrigin } from "./request-security.ts";
import { testflightUrl } from "./testflight.ts";
import { escapeHtml } from "../shared/escape-html.ts";
import { sessionByToken, session, currentUser, verifiedHuman, devLinks, appOrigin } from "./http/session.ts";
import { text } from "./http/common.ts";
import { agentSessionCapabilities } from "./http/agent-support.ts";
import { pairing } from "./routes/pairing.ts";
import { agents } from "./routes/agents.ts";
import { links } from "./routes/links.ts";
import { cacheGravatar } from "./http/profiles.ts";
import { admin } from "./routes/admin.ts";
import { polls } from "./routes/polls.ts";
import { channels } from "./routes/channels.ts";
import { workspaceIconVersion } from "./http/media.ts";
import { uploads } from "./routes/uploads.ts";
import { invitations } from "./routes/invitations.ts";
import { buildClient, buildVideoEncode, versionShell, assetCacheControl } from "./http/assets.ts";
import { joinlinks } from "./routes/join-links.ts";
import { bots } from "./routes/bots.ts";
import { irc } from "./routes/irc.ts";
import { embeds } from "./routes/embeds.ts";
import { PLAYER_HOSTS } from "./routes/embeds.ts";
import { peekRoutes } from "./routes/peek.ts";
import { profile } from "./routes/profile.ts";
import { notes } from "./routes/notes.ts";
import { publicRoomPaths } from "./http/public-rooms.ts";
import { ircConnectionMeta } from "./http/irc-connection.ts";
import { auth } from "./routes/auth.ts";
import { reminders } from "./routes/reminders.ts";
import { dms } from "./routes/dms.ts";
import { welcome } from "./routes/welcome.ts";
import { push } from "./routes/push.ts";
import { projects } from "./routes/projects.ts";
export { settleSignIns } from "./routes/auth.ts";
export { clientVersion, buildClient, assetVersion, versionShell } from "./http/assets.ts";
export { untrustedMediaHeaders } from "./http/media.ts";
export { agentSessionCapabilities, AGENT_POLL_MAX_WAIT_S, AGENT_SSE_KEEPALIVE_MS } from "./http/agent-support.ts";
export { sessionByToken } from "./http/session.ts";

assertDirectReadiness(db);

const app = new Hono();

// Explicit CORS for cross-origin multi-instance clients, scoped strictly to /auth/me,
// /auth/logout, and /irc. Only allowed origins get reflected, and
// Access-Control-Allow-Credentials is always false (bearer-only, never cookies cross-origin).
const multiInstanceCors = async (c: any, next: () => Promise<void>) => {
  const origin = c.req.header("Origin");
  const isDevCors = devLinks || process.env.NODE_ENV === "development" || process.env.SLIRC_DEV_PROFILE === "slirc2";
  const allowed = !!origin && isAllowedClientOrigin(origin, { dev: isDevCors });
  if (c.req.method === "OPTIONS") {
    if (allowed) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      c.header("Access-Control-Allow-Credentials", "false");
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin");
    }
    return c.body(null, 204);
  }
  await next();
  if (!allowed) return;
  const headers = new Headers(c.res.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Credentials", "false");
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Origin");
  else if (!vary.split(",").some((part) => part.trim().toLowerCase() === "origin")) headers.set("Vary", `${vary}, Origin`);
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
};
app.use("/auth/me", multiInstanceCors);
app.use("/auth/logout", multiInstanceCors);
app.use("/irc", multiInstanceCors);

// LAN HTTP is test-only. Do not let Safari's PWA cache hide source changes from phone testing.
app.use("*", async (c, next) => {
  if (devLinks && c.req.method === "GET") {
    c.header("Cache-Control", "no-store");
    // Dev-only phone layout: it keys off (pointer: coarse), which a desktop browser never
    // reports, so the phone screens cannot be checked without a device. ?phone=1 sets the cookie.
    const phone = c.req.query("phone");
    if (phone !== undefined) setCookie(c, "slirc_phone", phone === "1" ? "1" : "", { path: "/", sameSite: "Lax" });
  }
  await next();
});
// The shell and its service worker must never come from a stale HTTP cache: Safari otherwise keeps
// an old index.html (and an old sw.js, so no new CACHE name is ever seen) long past a deploy.
app.use("*", async (c, next) => {
  await next();
  const isShell = c.req.path === "/sw.js" || (c.res.headers.get("content-type") || "").includes("text/html");
  if (!isShell || c.res.headers.has("Cache-Control")) return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", "no-cache");
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

// Second line against injected markup: pages run only scripts served from this origin, never inline
// ones or event-handler attributes. The vendored standard Alpine build compiles its x-* expressions
// with new Function, hence 'unsafe-eval'; the CSP build cannot parse the shell's expressions. Inline
// <style> and style attributes stay allowed. Frames are limited to the player hosts the media dialog
// embeds. Responses that set their own policy (untrusted media) keep it.
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `frame-src ${[...PLAYER_HOSTS].map((host) => `https://${host}`).join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
app.use("*", async (c, next) => {
  await next();
  if (!(c.res.headers.get("content-type") || "").includes("text/html") || c.res.headers.has("Content-Security-Policy")) return;
  const headers = new Headers(c.res.headers);
  headers.set("Content-Security-Policy", contentSecurityPolicy());
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

// The app sets its own cache headers for the files a page loads, so nothing depends on what a
// proxy does by default with a .js or .css address.
app.use("*", async (c, next) => {
  await next();
  const path = c.req.path;
  if (c.req.method !== "GET" || path.startsWith("/api/") || path === "/sw.js" || c.res.status !== 200) return;
  if (!/\.(js|css|webmanifest|svg)$/.test(path) || c.res.headers.has("Cache-Control")) return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", await assetCacheControl(path, c.req.query("v")));
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

app.get("/healthz", (c) => c.json({ status: "ok" }));
// Report the hash of the client bundle actually served.
app.get("/api/version", async (c) => {
  c.header("Cache-Control", "no-store");
  const build = await buildClient();
  return c.json({ version: build?.version || "" });
});

// Native app links for admitted members. The TestFlight link is public once known, so it stays out
// of the client bundle, HTML and docs: only signed-in, verified humans can read it here.
app.get("/api/apps", (c) => {
  c.header("Cache-Control", "no-store");
  if (!currentUser(c)) return c.json({ error: "not signed in" }, 401);
  if (!verifiedHuman(c)) return c.json({ error: "verified account required" }, 403);
  return c.json({ testflight: testflightUrl(process.env.TESTFLIGHT_URL) });
});

app.route("/", pairing);

// One stream per signed-in browser tab; pairing requests arrive here instead of waiting for a poll.
app.get("/api/events", (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  c.header("Cache-Control", "no-store");
  return streamSSE(c, async (stream) => {
    const queue: { event: string; data: unknown }[] = [];
    let wake: (() => void) | null = null;
    let open = true;
    const unsubscribe = subscribe(nick, (event, data) => {
      queue.push({ event, data });
      wake?.();
      wake = null;
    });
    stream.onAbort(() => {
      open = false;
      unsubscribe();
      wake?.();
      wake = null;
    });
    await stream.writeSSE({ event: "ready", data: "1" });
    await stream.writeSSE({ event: "agent-requests", data: JSON.stringify(ownerAgentRequestStates(nick)) });
    while (open) {
      if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
      while (open && queue.length) {
        const item = queue.shift() as { event: string; data: unknown };
        await stream.writeSSE({ event: item.event, data: JSON.stringify(item.data) });
      }
    }
  });
});

app.route("/", agents);

app.route("/", bots);

app.route("/", irc);

for (const account of allAccounts()) void cacheGravatar(account.nick);

app.route("/", profile);

app.route("/", admin);

// Best effort: an invite that cannot open the DM is still a joined channel.
async function ensureDirectConversation(nick: string, other: string): Promise<void> {
  try {
    await openDirectConversation(nick, other);
  } catch (error) {
    console.error(`direct channel failed for ${nick} and ${other}:`, error);
  }
}

app.route("/", reminders);

app.route("/", polls);

app.route("/", dms);

app.route("/", notes);

app.route("/", auth);

app.route("/", invitations);

app.route("/", links);

app.route("/", welcome);

app.route("/", peekRoutes);

app.route("/", push);

app.route("/", embeds);

app.route("/", uploads);

// Read once at start so a bad SLIRC_EMOJI_BUDGET_BYTES stops the app instead of the first add.
emojiBudgetBytes();

app.route("/", channels);

app.route("/", projects);

app.route("/", joinlinks);

// The docs site is served by Caddy from app/public on its own host; see caddy/slirc.caddy.
// Client shell: the one index.html document is served directly at every canonical route, with
// head injection for the pieces the shared template cannot know about. No boot.html wrapper.
function injectCandidateHead(html: string): string {
  const head: string[] = [];
  if (!/rel="manifest"/.test(html)) head.push('<link rel="manifest" href="/manifest.webmanifest" />');
  if (!html.includes("sw-register.js")) head.push('<script src="/sw-register.js"></script>');
  return head.length ? html.replace("</head>", `${head.join("")}</head>`) : html;
}
// The shell says whether this workspace has an icon, and which one, so the client asks
// /api/workspace-icon only when there is one: a missing icon is a 404 the console reports.
function injectWorkspaceIcon(html: string): string {
  const version = workspaceIconVersion();
  return version ? html.replace("</head>", `<meta name="slirc-workspace-icon" content="${version}" /></head>`) : html;
}
async function clientShell(c: Context) {
  const html = await Bun.file("./public/index.html").text();
  c.header("Cache-Control", "no-cache");
  return c.html(await versionShell(injectWorkspaceIcon(injectCandidateHead(html))));
}
const serveShell = clientShell;

async function clientBundle(c: Context) {
  const build = await buildClient();
  if (!build) return c.text("Client build failed. Check app log.", 503);
  c.header("Cache-Control", await assetCacheControl("/client.js", c.req.query("v")));
  return c.body(build.body, 200, { "Content-Type": "text/javascript; charset=utf-8" });
}

// Phone tabs are routes (/ is Home, /dms, /more) so a reload lands where you were.
for (const tab of ["/", "/dms", "/more"]) {
  app.get(tab, clientShell);
}
for (const pub of publicRoomPaths()) app.get(`/${pub}`, serveShell);
// Static docs site: /docs and /docs/<guide> serve directory index.html files.
for (const doc of ["", "about", "agents", "bots", "channels", "clients", "comparison", "getting-started", "messages", "notifications", "privacy", "threads"]) {
  const path = doc ? `/docs/${doc}` : "/docs";
  const file = doc ? `/docs/${doc}/index.html` : "/docs/index.html";
  app.get(path, serveStatic({ root: "./public", rewriteRequestPath: () => file }));
  app.get(`${path}/`, serveStatic({ root: "./public", rewriteRequestPath: () => file }));
}
// First steps for a new member, linked from the help DM. Public, no account data: the page names
// this instance and its IRC server, both from server config, never from the request Host.
app.get("/welcome", async (c) => {
  const irc = ircConnectionMeta();
  // Only released harnesses are named as working; the agent package's registry is the one list.
  const today = offeredHarnesses().map((harness) => harness.name);
  const named = today.length < 2 ? today.join("") : `${today.slice(0, -1).join(", ")} and ${today.at(-1)}`;
  const agentsToday = today.length ? `${named} ${today.length > 1 ? "work" : "works"} today.` : "";
  const fill: Record<string, string> = { host: instanceHost(), ircHost: irc.host, ircPort: String(irc.port), agentsToday };
  let html = await Bun.file("./public/welcome.html").text();
  // No advertised IRC server: drop the card rather than show a blank address.
  if (!irc.host || irc.local) html = html.replace(/<li data-irc>[\s\S]*?<\/li>/, "");
  // Agents off on this instance, or none shipped: no agent card.
  if (!agentSessionCapabilities.enabled || !today.length) html = html.replace(/<li data-agents>[\s\S]*?<\/li>/, "");
  html = html.replace(/\{\{(host|ircHost|ircPort|agentsToday)\}\}/g, (_, key: string) => escapeHtml(fill[key]));
  c.header("Cache-Control", "no-cache");
  return c.html(await versionShell(html));
});
// Universal Links. iOS opens these paths in the Slirc app instead of Safari when the app is
// installed and its entitlement names this host. Apple's CDN fetches the file from every such host
// and follows no redirects. The paths are the links people get by email, QR code or chat: the
// workspace root, where a message link keeps its room in the fragment, DMs, phone pairing, join and
// invitation links, sign-in links and admission links. Docs and every other page stay in the browser.
const APPLE_APPLINK_COMPONENTS = ["/", "/dm/*", "/pair", "/pair/*", "/j/*", "/join/*", "/auth/verify", "/admission"].map((path) => ({ "/": path }));

export function appleAppIds(raw = process.env.APPLE_APP_IDS): string[] {
  return (raw || "").split(",").map((id) => id.trim()).filter(Boolean);
}

app.get("/.well-known/apple-app-site-association", (c) => {
  const appIDs = appleAppIds();
  if (!appIDs.length) return c.notFound();
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ applinks: { details: [{ appIDs, components: APPLE_APPLINK_COMPONENTS }] } });
});
// llms.txt convention: agents look at the site root first.
app.get("/llms.txt", (c) => c.redirect("/docs/llms.txt", 302));
app.get("/join/:token", serveShell);
app.get("/admission", serveShell);
for (const route of ["/profile", "/settings", "/channels", "/invitations", "/prelaunch", "/clients", "/agents", "/admin"]) app.get(route, clientShell);
// A direct-message link is /dm/<nick>, a channel is /#<channel>.
// Your own nick is not a DM: /dm/<you> opens your Notes.
app.get("/dm/:nick", async (c) => {
  const nick = currentUser(c);
  if (nick && nick.toLowerCase() === c.req.param("nick").toLowerCase()) return c.redirect("/notes", 302);
  return serveShell(c);
});
app.get("/notes", serveShell);
// Phone pairing by QR lands here with the token in the fragment. This GET only serves the shell and
// never signs anyone in: page script POSTs the token, so previews and scanners cannot spend an offer.
app.get("/pair", serveShell);
// Pairing from the link lands on the root query the client reads, not a client path.
app.get("/pair/:code", (c) => c.redirect(`/?pair=${encodeURIComponent(c.req.param("code"))}`, 302));

app.get("/client.js", clientBundle);
app.get("/video-encode.js", async (c) => {
  const build = await buildVideoEncode();
  if (!build) return c.text("Video encoder build failed. Check app log.", 503);
  c.header("Cache-Control", await assetCacheControl("/video-encode.js", c.req.query("v")));
  return c.body(build.body, 200, { "Content-Type": "text/javascript; charset=utf-8" });
});
// Keep installed clients' bootstrap URL pointed at the current shell.
app.get("/index.html", clientShell);

// Old installed clients update through /sw.js. Retire shell caches without touching drafts or outbox.
app.get("/boot.html", (c) => c.redirect("/", 302));
app.get("/sw.js", async (c) => c.body(await Bun.file("./public/sw.js").text(), 200, { "Content-Type": "text/javascript; charset=utf-8" }));

// Dev-only: serve the stylesheet with the coarse-pointer queries widened, so ?phone=1 shows the phone
// layout in a desktop browser. Rewriting is what makes this work at all: the `not (pointer: coarse)`
// blocks have to be neutralised too, and a second stylesheet cannot un-apply them.
app.get("/style.css", async (c, next) => {
  const forced = devLinks && (c.req.header("Cookie") || "").includes("slirc_phone=1");
  if (!forced) return next();
  const css = await Bun.file("./public/style.css").text();
  const phone = css.replaceAll("(not (pointer: coarse))", "(not (min-width: 0))")
    .replaceAll("(pointer: coarse)", "(pointer: coarse), (min-width: 0)");
  c.header("Cache-Control", "no-store");
  return c.body(phone, 200, { "Content-Type": "text/css; charset=utf-8" });
});

app.get("*", serveStatic({ root: "./public" }));

export { app };

const port = Number(process.env.PORT || 8080);
// Bun closes idle keep-alive sockets after 10s by default. Safari reuses the dead
// socket for the next POST and surfaces "Load failed" instead of retrying. 255s is Bun's max.
// /irc is the authenticated IRC relay (relay.ts), mounted on the app's own origin in every
// environment.
const baseRelayDeps = {
  sessionByToken,
  ircPasswordFor: (nick: string) => accountByNick(nick)?.ircPassword,
  appOrigin: process.env.NODE_ENV === "test" && !process.env.APP_ORIGIN && !process.env.APP_HOST ? "" : configuredAppOrigin(),
  isAllowedClientOrigin: (origin: string | null | undefined) =>
    isAllowedClientOrigin(origin, { dev: devLinks || process.env.NODE_ENV === "development" || process.env.SLIRC_DEV_PROFILE === "slirc2" }),
  ergoHost: process.env.ERGO_HOST || "ergo",
  ergoPort: Number(process.env.ERGO_PORT || 6667),
  webircPass: process.env.ERGO_WEBIRC_PASS,
  mode: slircMode(),
  onLine: observeReplyLine,
};
const relayHandlers = relayWebsocketHandlers(baseRelayDeps);
if (process.env.NODE_ENV !== "test") {
  // One explicit continuity-gap reset owned by the app entrypoint (never an import side effect).
  resetAgentSessionState();
  for (const binding of db.query("SELECT * FROM agent_session_bindings WHERE status='ready'").all() as Binding[]) {
    void connectAgentTransport(binding).catch(() => console.error(`session transport unavailable for ${binding.id}`));
  }
}

// No IRC key, no start: every IRC password derives from it (irc-key.ts).
ircKey();
const server = process.env.NODE_ENV === "test" ? null : Bun.serve({
  port,
  idleTimeout: 255,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/irc") {
      return handleRelayUpgrade(
        req,
        "/irc",
        (r, options) => server.upgrade(r, options),
        { ...baseRelayDeps, appOrigin: appOrigin(req.headers.get("Host")) },
        server.requestIP(req)?.address || "127.0.0.1",
      );
    }
    return app.fetch(req, { server });
  },
  websocket: {
    open(ws) { relayHandlers.open(ws as any); },
    message(ws, raw) { relayHandlers.message(ws as any, raw); },
    close(ws) { relayHandlers.close(ws as any); },
  },
});
if (server) {
  const sweepTimer = setInterval(sweepExpired, 60_000);
  sweepTimer.unref();
  const agentPresenceTimer = setInterval(syncAgentPresence, 5_000);
  agentPresenceTimer.unref();
  const shutdown = async () => {
    await server.stop(true);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.log(`app listening on :${port}`);
}

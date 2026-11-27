// iPhone push through Apple Push Notification service, signed with a token key (.p8) from
// apnsConfig(). The key, its ID and the team ID come from the instance env and only sign requests
// here; nothing logs them. Without them every send is skipped and the app reports iPhone
// notifications as not set up.
import { connect, type ClientHttp2Session } from "node:http2";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { apnsConfig, type ApnsConfig } from "./config.ts";

// A Debug build from Xcode registers with Apple's sandbox; TestFlight and App Store builds with
// production. Each token works only with the server it came from.
export type ApnsEnvironment = "sandbox" | "production";
const HOSTS: Record<ApnsEnvironment, string> = { sandbox: "https://api.sandbox.push.apple.com", production: "https://api.push.apple.com" };

export function isApnsToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64,200}$/i.test(value);
}

export function isApnsEnvironment(value: unknown): value is ApnsEnvironment {
  return value === "sandbox" || value === "production";
}

// Apple accepts a provider token for an hour and refuses one renewed more often than every 20
// minutes, so one is reused for 40.
let cached: { value: string; at: number; keyId: string } | null = null;
export function apnsToken(config: ApnsConfig, now = Date.now()): string {
  if (cached && cached.keyId === config.keyId && now - cached.at < 40 * 60_000 && now >= cached.at) return cached.value;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "ES256", kid: config.keyId })}.${part({ iss: config.teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: createPrivateKey(config.key), dsaEncoding: "ieee-p1363" }).toString("base64url");
  cached = { value: `${unsigned}.${signature}`, at: now, keyId: config.keyId };
  return cached.value;
}

// What the iPhone shows, and where a tap goes: origin names the workspace, since one phone can
// hold several, and url is the route inside it. Apple caps a payload at 4 KB.
export function apnsPayload(note: { title: string; body: string; url: string; origin: string; thread: string }) {
  const body = note.body.length > 1000 ? note.body.slice(0, 1000) + "…" : note.body;
  return { aps: { alert: { title: note.title.slice(0, 200), body }, sound: "default", "thread-id": note.thread.slice(0, 64) }, origin: note.origin, url: note.url };
}

// Apple's answers that mean the token will never work again, so its row goes.
export function deadToken(status: number, reason: string): boolean {
  return status === 410 || (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"));
}

// One HTTP/2 connection per Apple server, kept open between sends as Apple asks.
const sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
function session(environment: ApnsEnvironment): ClientHttp2Session {
  const open = sessions.get(environment);
  if (open && !open.closed && !open.destroyed) return open;
  const made = connect(HOSTS[environment]);
  const forget = () => { if (sessions.get(environment) === made) sessions.delete(environment); };
  made.on("error", forget);
  made.on("close", forget);
  made.on("goaway", forget);
  made.unref();
  sessions.set(environment, made);
  return made;
}

// Never throws for an answer from Apple; a key that can't sign does throw, and the caller logs it.
export async function sendApns(device: { token: string; environment: ApnsEnvironment }, payload: unknown, collapse: string, config: ApnsConfig | null = apnsConfig()): Promise<{ status: number; reason: string }> {
  if (!config) return { status: 0, reason: "not configured" };
  const request = session(device.environment).request({
    ":method": "POST",
    ":path": `/3/device/${device.token}`,
    authorization: `bearer ${apnsToken(config)}`,
    "apns-topic": config.topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-collapse-id": createHash("sha256").update(collapse).digest("hex").slice(0, 32),
  });
  return await new Promise((resolve) => {
    let status = 0, text = "";
    const timer = setTimeout(() => { request.close(); resolve({ status: 0, reason: "timeout" }); }, 10_000);
    request.setEncoding("utf8");
    request.on("response", (headers) => { status = Number(headers[":status"]) || 0; });
    request.on("data", (chunk: string) => { text += chunk; });
    request.on("end", () => {
      clearTimeout(timer);
      let reason = "";
      try { reason = text ? String(JSON.parse(text).reason || "") : ""; } catch {}
      resolve({ status, reason });
    });
    request.on("error", (error) => { clearTimeout(timer); resolve({ status: 0, reason: error.message }); });
    request.end(JSON.stringify(payload));
  });
}

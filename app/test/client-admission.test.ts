// Owner and newcomer admission UI behavior. Focused only: the approved email fragment format,
// no POST on open, explicit redemption with a frozen claim+name and a visible retry, fixed
// destinations opened only after an explicit redemption, and the founder review outcomes. No
// browser, no network, no real mail. Non-browser evidence only.
import { beforeEach, expect, test } from "bun:test";
import {
  createAdmissionFounder, createAdmissionScreen, admissionRecordKey, admissionStateLabel,
  canApproveAdmission, canCancelAdmission, canReissueAdmission, mergeAdmissionRows,
  normalizeDestination,
} from "@client/admission.ts";
import { parseRoute, resolveConversationId, routeUrl } from "@client/navigation.ts";
import { routeFromMount, signInNext } from "@client/presentation.ts";

const ORIGIN = "https://app.slirc.org";
// The literal approved email URL shape, never an invented bare-token fragment.
const EMAIL_URL_HELP = "/admission#token=tok-abc_123&destination=help";
const EMAIL_URL_FOUNDER = "/admission#token=tok-abc_123&destination=founder";

interface Call { path: string; method: string; headers: Record<string, string>; body: any }

function withFetch(run: (calls: Call[], respond: (fn: (call: Call) => Promise<Response>) => void) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const calls: Call[] = [];
  let responder: (call: Call) => Promise<Response> = async () => Response.json({ error: "no response set" }, { status: 500 });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (path: string, init?: RequestInit) => {
      const call: Call = { path, method: init?.method || "GET", headers: (init?.headers as Record<string, string>) || {}, body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      return responder(call);
    },
  });
  return (async () => {
    try { await run(calls, (fn) => { responder = fn; }); }
    finally { if (saved) Object.defineProperty(globalThis, "fetch", saved); else Reflect.deleteProperty(globalThis, "fetch"); }
  })();
}

class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });

beforeEach(() => storage.clear());

function session(key = "acct-founder") {
  return { scope: () => ({ instance: "https://slirc.example.test", account: "eve", accountId: key }), key: () => key, stopped: () => false, signingOut: () => false };
}

function newcomer(calls: Call[], respond: (fn: (call: Call) => Promise<Response>) => void, overrides: Record<string, unknown> = {}) {
  const openedDirect: string[] = [];
  const openedRoom: string[] = [];
  let homes = 0; let logouts = 0; let connected = 0; let accountId = "";
  const core = { authenticated: false, account: "eve", admissionSignIn: false };
  const page = createAdmissionScreen((value) => value, {
    core,
    session: session(),
    connect: async () => { connected += 1; },
    openDirect: (nick) => { openedDirect.push(nick); },
    openRoom: (room) => { openedRoom.push(room); },
    goHome: () => { homes += 1; },
    logout: () => { logouts += 1; },
    authenticatedAccountId: () => accountId,
    destinationReachable: () => true,
    ...overrides,
  });
  return {
    page, core, openedDirect, openedRoom, homes: () => homes, logouts: () => logouts,
    connected: () => connected, setAccountId: (next: string) => { accountId = next; },
  };
}

// ---------------------------------------------------------------------------
// Approved email fragment routing
// ---------------------------------------------------------------------------

test("the approved email URL parses token and destination and round-trips", () => {
  expect(parseRoute(EMAIL_URL_HELP, ORIGIN)).toEqual({ kind: "admission", token: "tok-abc_123", destination: "help" });
  expect(parseRoute(EMAIL_URL_FOUNDER, ORIGIN)).toEqual({ kind: "admission", token: "tok-abc_123", destination: "founder" });
  expect(routeUrl({ kind: "admission", token: "tok-abc_123", destination: "founder" })).toBe(EMAIL_URL_FOUNDER);
  expect(routeUrl({ kind: "admission", token: "tok-abc_123", destination: "help" })).toBe(EMAIL_URL_HELP);
  expect(parseRoute(routeUrl({ kind: "admission", token: "tok-abc_123", destination: "founder" }), ORIGIN))
    .toEqual({ kind: "admission", token: "tok-abc_123", destination: "founder" });
  expect(resolveConversationId({ kind: "admission", token: "tok-abc_123", destination: "help" })).toBeNull();
});

test("a bare fragment is not a token and an unknown destination falls back to help", () => {
  // A bare hash has no `token=` capability and must not be treated as one.
  expect(parseRoute("/admission#tok-abc_123", ORIGIN)).toEqual({ kind: "admission", token: "", destination: "help" });
  expect(parseRoute("/admission", ORIGIN)).toEqual({ kind: "admission", token: "", destination: "help" });
  expect(parseRoute("/admission#token=tok-abc&destination=dm-someone", ORIGIN)).toEqual({ kind: "admission", token: "tok-abc", destination: "help" });
  expect(parseRoute("/admission?room=%23x", ORIGIN)).toBeNull();
  expect(parseRoute("/admission?msg=srv-1", ORIGIN)).toBeNull();
  expect(parseRoute("/admission#token=bad%20token&destination=help", ORIGIN)).toBeNull();
});

test("the capability never reaches the server-visible next path", () => {
  expect(signInNext(routeFromMount("/admission", "#token=tok-abc&destination=founder", ""), ORIGIN)).toBe("/admission");
  expect(signInNext(routeFromMount("/admission", "#token=tok-abc&destination=founder", "?x=1"), ORIGIN)).toBe("/admission");
});

// ---------------------------------------------------------------------------
// Newcomer screen
// ---------------------------------------------------------------------------

test("opening the screen never sends a request and keeps the requested destination", () => withFetch(async (calls) => {
  const { page } = newcomer(calls, () => {});
  page.start("tok-abc", "founder");
  expect(calls).toHaveLength(0);
  expect(page.token).toBe("tok-abc");
  expect(page.destination).toBe("founder");
  expect(page.redeemed).toBe(false);
  expect(page.attempted).toBe(false);
}));

test("a persisted attempt is reloaded with its exact claim and locked name", () => {
  storage.setItem(admissionRecordKey("tok-abc"), JSON.stringify({ claim: "c".repeat(32), name: "Ada Lovelace" }));
  const { page } = newcomer([], () => {});
  page.start("tok-abc", "help");
  expect(page.attempted).toBe(true);
  expect(page.claim).toBe("c".repeat(32));
  expect(page.name).toBe("Ada Lovelace");
});

test("explicit submission posts the frozen identity, then opens the requested destination", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, connected } = newcomer(calls, respond);
  respond(async (call) => {
    if (call.path === "/api/admission/redeem") return Response.json({ admissionId: "adm-1", accountId: "acct-new", nick: "Ada" }, { status: 201 });
    if (call.path === "/api/admission/destination") return Response.json({ type: "direct", channel: "#dm-help", nick: "help" });
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  page.start("tok-abc", "help");
  page.name = "  Ada  ";
  await page.submit();
  const post = calls.find((call) => call.path === "/api/admission/redeem")!;
  expect(post.method).toBe("POST");
  expect(post.headers["Content-Type"]).toBe("application/json");
  expect(post.headers["X-Slirc-Admission"]).toBe("1");
  expect(post.body.token).toBe("tok-abc");
  expect(post.body.name).toBe("Ada");
  expect(post.body.browserClaim).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(page.redeemed).toBe(true);
  expect(connected()).toBeGreaterThanOrEqual(1);
  const destination = calls.find((call) => call.path === "/api/admission/destination")!;
  expect(destination.body).toEqual({ token: "tok-abc", destination: "help" });
  expect(openedDirect).toEqual(["help"]);
  const stored = JSON.parse(storage.getItem(admissionRecordKey("tok-abc"))!);
  expect(stored.claim).toBe(post.body.browserClaim);
}));

test("a founder-requested link opens the founder destination, not help", () => withFetch(async (calls, respond) => {
  const { page, openedDirect } = newcomer(calls, respond);
  respond(async (call) => {
    if (call.path === "/api/admission/redeem") return Response.json({ admissionId: "adm-1", accountId: "acct-new", nick: "Ada" }, { status: 201 });
    if (call.path === "/api/admission/destination") return Response.json({ type: "direct", channel: "#dm-founder", nick: "founder" });
    return Response.json({}, { status: 500 });
  });
  page.start("tok-abc", "founder");
  page.name = "Ada";
  await page.submit();
  expect(calls.find((call) => call.path === "/api/admission/destination")!.body).toEqual({ token: "tok-abc", destination: "founder" });
  expect(openedDirect).toEqual(["founder"]);
}));

test("an ambiguous retry keeps a visible retry and reuses the same claim and name", () => withFetch(async (calls, respond) => {
  const { page } = newcomer(calls, respond);
  let attempt = 0;
  respond(async (call) => {
    if (call.path !== "/api/admission/redeem") return Response.json({});
    attempt += 1;
    if (attempt === 1) throw new Error("network down");
    return Response.json({ admissionId: "adm-1", accountId: "acct-new", nick: "Ada" }, { status: 201 });
  });
  page.start("tok-abc", "help");
  page.name = "Ada";
  await page.submit();
  expect(page.error).toContain("could not confirm");
  expect(page.attempted).toBe(true);
  page.name = "Changed";
  await page.submit();
  const posts = calls.filter((call) => call.path === "/api/admission/redeem");
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.browserClaim).toBe(posts[0]!.body.browserClaim);
  expect(posts[1]!.body.name).toBe("Ada");
}));

test("a server name rejection before a claim unfreezes the name and mints a fresh claim", () => withFetch(async (calls, respond) => {
  const { page } = newcomer(calls, respond);
  let attempt = 0;
  respond(async (call) => {
    if (call.path !== "/api/admission/redeem") return Response.json({});
    attempt += 1;
    if (attempt === 1) return Response.json({ error: "display name is not allowed" }, { status: 400 });
    return Response.json({ admissionId: "adm-1", accountId: "acct-new", nick: "Corrected" }, { status: 201 });
  });
  page.start("tok-abc", "help");
  page.name = "Bad Name";
  await page.submit();
  expect(page.attempted).toBe(false);
  expect(page.claim).toBe("");
  expect(storage.getItem(admissionRecordKey("tok-abc"))).toBeNull();
  page.name = "Corrected";
  await page.submit();
  const posts = calls.filter((call) => call.path === "/api/admission/redeem");
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.name).toBe("Corrected");
  expect(posts[1]!.body.browserClaim).not.toBe(posts[0]!.body.browserClaim);
}));

test("an unavailable browser store explains itself instead of sending a fresh identity", () => withFetch(async (calls) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } } });
  try {
    const { page } = newcomer(calls, () => {});
    page.start("tok-abc", "help");
    page.name = "Ada";
    await page.submit();
    expect(page.storageError).toContain("cannot remember");
    expect(calls.some((call) => call.path === "/api/admission/redeem")).toBe(false);
  } finally {
    if (saved) Object.defineProperty(globalThis, "sessionStorage", saved);
  }
}));

test("a wrong account is explained and never silently retried under another identity", () => withFetch(async (calls, respond) => {
  const { page } = newcomer(calls, respond);
  respond(async () => Response.json({ error: "account mismatch" }, { status: 403 }));
  page.start("tok-abc", "help");
  page.name = "Ada";
  await page.submit();
  expect(page.wrongAccount).toBe(true);
  expect(page.attempted).toBe(true);
  expect(page.redeemed).toBe(false);
}));

test("a spent or expired token is treated as unavailable, not a second redemption", () => withFetch(async (calls, respond) => {
  const { page } = newcomer(calls, respond);
  respond(async () => Response.json({ error: "not available" }, { status: 404 }));
  page.start("tok-abc", "help");
  page.name = "Ada";
  await page.submit();
  expect(page.unavailable).toBe(true);
  expect(page.error).toContain("no longer available");
}));

test("a connect-time account reset does not cancel the requested destination", () => withFetch(async (calls, respond) => {
  const openedDirect: string[] = [];
  const page = createAdmissionScreen((value) => value, {
    core: { authenticated: false, account: "eve", admissionSignIn: false },
    session: session(),
    connect: async () => { page.reset(); },
    openDirect: (nick) => { openedDirect.push(nick); },
    openRoom: () => {},
    goHome: () => {},
    logout: () => {},
    authenticatedAccountId: () => "",
    destinationReachable: () => true,
  });
  respond(async (call) => {
    if (call.path === "/api/admission/redeem") return Response.json({ admissionId: "adm-1", accountId: "acct-new", nick: "Ada" }, { status: 201 });
    if (call.path === "/api/admission/destination") return Response.json({ type: "direct", channel: "#dm-help", nick: "help" });
    return Response.json({}, { status: 500 });
  });
  page.start("tok-abc", "help");
  page.name = "Ada";
  await page.submit();
  expect(calls.some((call) => call.path === "/api/admission/destination")).toBe(true);
  expect(openedDirect).toEqual(["help"]);
  expect(page.token).toBe("tok-abc");
  expect(page.destination).toBe("help");
  expect(page.name).toBe("Ada");
}));

// ---------------------------------------------------------------------------
// Destinations after redemption
// ---------------------------------------------------------------------------

function redeemed(calls: Call[], respond: (fn: (call: Call) => Promise<Response>) => void, overrides: Record<string, unknown> = {}) {
  storage.setItem(admissionRecordKey("tok-abc"), JSON.stringify({
    claim: "c".repeat(32), name: "Ada",
    redeemed: { admissionId: "adm-1", accountId: "acct-new", nick: "Ada" },
  }));
  return newcomer(calls, respond, overrides);
}

test("a preview never posts, and a destination failure never redeems twice", () => withFetch(async (calls, respond) => {
  const { page } = redeemed(calls, respond);
  page.start("tok-abc", "founder");
  expect(calls).toHaveLength(0); // preview only: no init POST
  let attempt = 0;
  respond(async () => {
    attempt += 1;
    if (attempt === 1) return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    return Response.json({ type: "direct", channel: "#dm-founder", nick: "founder" });
  });
  await page.openDestination("founder");
  expect(page.destinationError).toContain("Try again");
  await page.openDestination("founder");
  const destinations = calls.filter((call) => call.path === "/api/admission/destination");
  expect(destinations).toHaveLength(2);
  expect(calls.some((call) => call.path === "/api/admission/redeem")).toBe(false);
}));

test("destinations are fixed to help and founder, with help as the safe fallback", () => {
  expect(normalizeDestination("founder")).toBe("founder");
  expect(normalizeDestination("help")).toBe("help");
  expect(normalizeDestination("dm-someone")).toBe("help");
  expect(normalizeDestination(undefined)).toBe("help");
});

test("a fixed destination posts the chosen kind and opens the returned conversation", () => withFetch(async (calls, respond) => {
  const { page, openedDirect } = redeemed(calls, respond, { destinationReachable: () => true });
  page.start("tok-abc", "founder");
  respond(async () => Response.json({ type: "direct", channel: "#dm-founder", nick: "founder" }));
  await page.openDestination("founder");
  const post = calls.find((call) => call.path === "/api/admission/destination")!;
  expect(post.body).toEqual({ token: "tok-abc", destination: "founder" });
  expect(openedDirect).toEqual(["founder"]);
}));

test("a wrong account on a destination asks for sign-out instead of redeeming again", () => withFetch(async (calls, respond) => {
  const { page } = redeemed(calls, respond);
  page.start("tok-abc", "help");
  respond(async () => Response.json({ error: "wrong account" }, { status: 403 }));
  await page.openDestination("help");
  expect(page.wrongAccount).toBe(true);
  expect(calls.some((call) => call.path === "/api/admission/redeem")).toBe(false);
}));

// ---------------------------------------------------------------------------
// Founder review
// ---------------------------------------------------------------------------

function founder(calls: Call[], respond: (fn: (call: Call) => Promise<Response>) => void) {
  return createAdmissionFounder((value) => value, { core: { authenticated: true }, session: session() });
}

const APPLICATION = { id: "app-1", email: "new@example.com", selfhost: true, createdAt: 1, revision: 3 };

test("a non-founder 404 hides the section and a transport failure does not", () => withFetch(async (calls, respond) => {
  const page = founder(calls, respond);
  respond(async () => Response.json({ error: "not found" }, { status: 404 }));
  await page.load();
  expect(page.visible).toBe(false);
  expect(page.checked).toBe(true);

  respond(async () => Response.json({ applications: [APPLICATION], admissions: [] }));
  await page.reload();
  expect(page.rows()).toHaveLength(1);
  respond(async () => Response.json({ error: "not found" }, { status: 404 }));
  await page.reload();
  expect(page.visible).toBe(false);
  expect(page.rows()).toHaveLength(0);

  const failing = founder([], () => {});
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => { throw new Error("offline"); } });
  try {
    await failing.load();
    expect(failing.visible).toBe(true);
    expect(failing.error).toContain("unchanged");
  } finally {
    if (saved) Object.defineProperty(globalThis, "fetch", saved);
  }
}));

test("approval merges the admission, keeps the boolean selfhost and a 502 payload is retained", () => withFetch(async (calls, respond) => {
  const page = founder(calls, respond);
  respond(async (call) => call.path === "/api/admissions"
    ? Response.json({ applications: [APPLICATION], admissions: [] })
    : Response.json({ error: "mail rejected" }, { status: 502 }));
  await page.load();
  expect(page.rows()).toHaveLength(1);
  expect(page.rows()[0]!.application.selfhost).toBe(true);
  expect(page.rows()[0]!.application.revision).toBe(3);
  expect(page.rows()[0]!.admission).toBeNull();
  respond(async () => Response.json({
    admission: { id: "adm-1", applicationId: "app-1", revision: 4, state: "pending", delivery: "failed", deliveryError: "mailbox rejected" },
  }, { status: 502 }));
  await page.approve(page.rows()[0]!);
  expect(page.rows()[0]!.admission!.id).toBe("adm-1");
  expect(page.rows()[0]!.admission!.delivery).toBe("failed");
  expect(admissionStateLabel(page.rows()[0]!)).toBe("Delivery failed");
}));

test("reissue keeps the same admission id and cancel reflects the server", () => withFetch(async (calls, respond) => {
  const page = founder(calls, respond);
  respond(async (call) => call.path === "/api/admissions"
    ? Response.json({ applications: [APPLICATION], admissions: [
      { id: "adm-1", applicationId: "app-1", revision: 4, state: "pending", delivery: "sent" },
    ] })
    : Response.json({}));
  await page.load();
  respond(async () => Response.json({ admission: { id: "adm-1", applicationId: "app-1", revision: 5, state: "pending", delivery: "sending" } }));
  await page.reissue(page.rows()[0]!);
  expect(page.rows()[0]!.admission!.id).toBe("adm-1");
  expect(page.rows()[0]!.admission!.revision).toBe(5);
  expect(canReissueAdmission(page.rows()[0]!)).toBe(true);
  respond(async () => Response.json({ cancelled: true }));
  await page.cancel(page.rows()[0]!);
  expect(page.rows()[0]!.admission!.state).toBe("cancelled");
  expect(canCancelAdmission(page.rows()[0]!)).toBe(false);
  expect(canReissueAdmission(page.rows()[0]!)).toBe(true);
  expect(admissionStateLabel(page.rows()[0]!)).toBe("Cancelled");
}));

test("reissue is offered for every unredeemed state and never for redeemed", () => {
  const make = (state: string, expiresAt?: number): any => ({ application: APPLICATION, admission: { id: "a", applicationId: "app-1", state, delivery: "sent", expiresAt } });
  expect(canReissueAdmission(make("pending"))).toBe(true);
  expect(canReissueAdmission(make("redeeming"))).toBe(true);
  expect(canReissueAdmission(make("cancelled"))).toBe(true);
  expect(canReissueAdmission(make("pending", 1))).toBe(true); // expired unredeemed
  expect(canReissueAdmission(make("redeemed"))).toBe(false);
  expect(canApproveAdmission(make("cancelled"))).toBe(false);
});

test("a redeemed admission is final with no approve, reissue or cancel controls", () => {
  const rows = mergeAdmissionRows([APPLICATION], [{ id: "adm-1", applicationId: "app-1", state: "redeemed", delivery: "sent" }]);
  expect(admissionStateLabel(rows[0]!)).toBe("Joined");
  expect(canApproveAdmission(rows[0]!)).toBe(false);
  expect(canReissueAdmission(rows[0]!)).toBe(false);
  expect(canCancelAdmission(rows[0]!)).toBe(false);
});

test("a cancel race surfaces the conflict and reloads the authoritative list", () => withFetch(async (calls, respond) => {
  const page = founder(calls, respond);
  respond(async (call) => call.path === "/api/admissions"
    ? Response.json({ applications: [APPLICATION], admissions: [
      { id: "adm-1", applicationId: "app-1", state: "pending", delivery: "sent" },
    ] })
    : Response.json({ error: "already redeemed" }, { status: 409 }));
  await page.load();
  await page.cancel(page.rows()[0]!);
  expect(page.rowError).toContain("changed while");
  expect(calls.filter((call) => call.path === "/api/admissions")).toHaveLength(2);
}));

test("a founder retry reloads after a transport failure", () => withFetch(async (calls, respond) => {
  const page = founder(calls, respond);
  let attempt = 0;
  respond(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("offline");
    return Response.json({ applications: [APPLICATION], admissions: [] });
  });
  await page.load();
  expect(page.error).not.toBe("");
  await page.reload();
  expect(page.error).toBe("");
  expect(page.rows()).toHaveLength(1);
}));

// ---------------------------------------------------------------------------
// Shell assembly and declarative controls
// ---------------------------------------------------------------------------

test("an explicit sign-in round trip keeps the capability and requested destination", () => {
  const first = newcomer([], () => {});
  first.page.start("tok-abc", "founder");
  first.page.requestSignIn();
  expect(first.core.admissionSignIn).toBe(true);
  // The redirected /admission load has no fragment token, so it must restore both from session state.
  const second = newcomer([], () => {});
  second.page.start("", "help");
  expect(second.page.token).toBe("tok-abc");
  expect(second.page.destination).toBe("founder");
});

test("a signed-out missing link shows the missing-code explanation", () => {
  const { page } = newcomer([], () => {});
  page.start("", "help");
  expect(page.started).toBe(true);
  expect(page.token).toBe("");
  expect(page.redeemed).toBe(false);
});

test("an account switch keeps the fragment capability, destination and retry identity", () => {
  storage.setItem(admissionRecordKey("tok-abc"), JSON.stringify({ claim: "c".repeat(32), name: "Ada" }));
  const { page } = newcomer([], () => {});
  page.start("tok-abc", "founder");
  page.reset();
  expect(page.token).toBe("tok-abc");
  expect(page.destination).toBe("founder");
  expect(page.attempted).toBe(true);
  expect(page.claim).toBe("c".repeat(32));
});

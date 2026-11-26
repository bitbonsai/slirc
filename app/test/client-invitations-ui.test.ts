// New-conversation dialog and sent-invitations page. Focused behavior only: recipient shaping,
// idempotency-key freezing across uncertain retries, destination navigation, and invitation
// read/resend/cancel. No browser, no network, no real mail.
import { expect, test } from "bun:test";
import {
  createNewConversation, newConversationStatusLabel,
  recipientPayload, conversationRecipientKey, validNewConversationPerson, conversationOutcomeIsRecorded,
} from "@client/new-conversation.ts";
import {
  createInvitationsPage, invitationStatusLabel, invitationDestinationLabel,
  canResendInvitation, canCancelInvitation, invitationDate, resendOutcomeIsRecorded,
} from "@client/invitations-page.ts";
import { parseRoute, routeUrl, resolveConversationId } from "@client/navigation.ts";
import { createInvitationAccept, joinDestinationLabel } from "@client/invitation-accept.ts";
import { routeFromMount, signInNext } from "@client/presentation.ts";

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

function session(key = "acct-1") {
  return { scope: () => ({ instance: "https://slirc.example.test", account: "eve", accountId: key }), key: () => key, stopped: () => false, signingOut: () => false };
}

function newConversation(calls: Call[], respond: (fn: (call: Call) => Promise<Response>) => void, overrides: Record<string, unknown> = {}) {
  const openedDirect: string[] = [];
  const openedRoom: string[] = [];
  let connected = 0;
  const accountIds: Record<string, string> = { bob: "bob-id", carol: "carol-id" };
  const page = createNewConversation((value) => value, {
    core: { authenticated: true, account: "eve", contacts: ["bob", "carol"] },
    session: session(),
    nextTick: async (cb) => { cb?.(); },
    connect: async () => { connected += 1; },
    openDirect: (nick) => { openedDirect.push(nick); },
    openRoom: (room) => { openedRoom.push(room); },
    accountIdFor: (nick) => accountIds[nick],
    avatarUrl: (nick) => `/api/avatar/${nick}`,
    ...overrides,
  });
  respond(async (call) => {
    if (call.path.startsWith("/api/invites/email")) return Response.json({ remaining: 9, limit: 9 });
    return Response.json({ error: "no response set" }, { status: 500 });
  });
  return { page, openedDirect, openedRoom, connected: () => connected };
}

const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,128}$/;

test("one account posts an account recipient with a frozen key and opens the pair DM", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, connected } = newConversation(calls, respond);
  respond(async () => Response.json({
    conversation: { type: "direct", channel: "#dm-bob", nick: "bob" },
    recipients: [{ accountId: "bob-id", nick: "bob", status: "added" }], remaining: 9, limit: 9,
  }));
  page.addPerson({ accountId: "bob-id", nick: "bob", displayName: "Bob", avatarUrl: "" });
  await page.submit();
  const post = calls.find((call) => call.path === "/api/conversations")!;
  expect(post.method).toBe("POST");
  expect(post.headers["Idempotency-Key"]).toMatch(IDEMPOTENCY);
  expect(post.body).toEqual({ recipients: [{ accountId: "bob-id" }] });
  expect(connected()).toBe(1);
  expect(openedDirect).toEqual(["bob"]);
  expect(page.settled).toBe(false); // reset after a clean completion
}));

test("a transport failure keeps the same idempotency key, payload, and selection on retry", () => withFetch(async (calls, respond) => {
  const { page, openedDirect } = newConversation(calls, respond);
  let attempt = 0;
  respond(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("network down");
    return Response.json({
      conversation: { type: "direct", channel: "#dm-bob", nick: "bob" },
      recipients: [{ accountId: "bob-id", nick: "bob", status: "added" }], remaining: 9, limit: 9,
    });
  });
  page.addPerson({ accountId: "bob-id", nick: "bob", displayName: "Bob", avatarUrl: "" });
  await page.submit();
  expect(page.error).toContain("Retry");
  expect(page.recipients).toHaveLength(1);
  await page.submit();
  const keys = calls.filter((call) => call.path === "/api/conversations").map((call) => call.headers["Idempotency-Key"]);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(openedDirect).toEqual(["bob"]);
}));

test("an unknown email stays pending with no conversation and no navigation", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, openedRoom, connected } = newConversation(calls, respond);
  respond(async () => Response.json({
    conversation: null, pending: true,
    recipients: [{ email: "new@example.com", status: "invited", invitationId: "inv-1" }], remaining: 8, limit: 9,
  }));
  page.emailInput = "New@Example.com";
  page.addEmail();
  await page.submit();
  expect(page.outcomes).toHaveLength(1);
  expect(page.note).toContain("when they accept");
  expect(openedDirect).toEqual([]);
  expect(openedRoom).toEqual([]);
  expect(connected()).toBe(0);
}));

test("changing recipients starts a new logical request with a new key", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  respond(async () => Response.json({ conversation: null, pending: true, recipients: [{ email: "a@example.com", status: "invited" }], remaining: 8, limit: 9 }));
  page.emailInput = "a@example.com"; page.addEmail();
  await page.submit();
  const first = calls.find((call) => call.path === "/api/conversations")!.headers["Idempotency-Key"];
  page.removeRecipient(0);
  page.emailInput = "b@example.com"; page.addEmail();
  await page.submit();
  const second = calls.filter((call) => call.path === "/api/conversations")[1]!.headers["Idempotency-Key"];
  expect(second).not.toBe(first);
}));

test("email validation and duplicate selection are rejected without adding a chip", () => {
  const { page } = newConversation([], () => {});
  page.emailInput = "not-an-email"; page.addEmail();
  expect(page.emailError).toContain("valid email");
  expect(page.recipients).toHaveLength(0);
  page.emailInput = "dup@example.com"; page.addEmail();
  page.emailInput = "DUP@example.com"; page.addEmail();
  expect(page.recipients).toHaveLength(1);
  expect(page.emailError).toContain("already selected");
});

test("contacts are suggested first, exclude the signed-in account and duplicates", () => {
  const { page } = newConversation([], () => {}, { core: { authenticated: true, account: "bob", contacts: ["bob", "carol"] } });
  const suggestions = page.contactSuggestions();
  expect(suggestions.map((person: any) => person.nick)).toEqual(["carol"]);
  page.addPerson({ accountId: "carol-id", nick: "carol", displayName: "Carol", avatarUrl: "" });
  expect(page.contactSuggestions()).toHaveLength(0);
});

test("choosing a person in direct mode opens the DM immediately with no conversation POST or connect", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, connected } = newConversation(calls, respond);
  respond(async () => Response.json({ error: "no response set" }, { status: 500 }));
  expect(page.mode).toBe("direct");
  page.setMode("direct");
  page.choosePerson({ accountId: "bob-id", nick: "bob", displayName: "Bob", avatarUrl: "" });
  expect(openedDirect).toEqual(["bob"]);
  expect(connected()).toBe(0);
  expect(calls.some((call) => call.path === "/api/conversations")).toBe(false);
  expect(page.recipients).toHaveLength(0);
}));

test("email query skips people lookup and sends only after explicit selection", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  page.query = "eve@example.test";
  expect(page.isEmailQuery()).toBe(true);
  await page.search();
  expect(calls.some((call) => call.path.startsWith("/api/people"))).toBe(false);
  expect(page.recipients).toHaveLength(0);
  respond(async () => Response.json({ conversation: null, pending: true, recipients: [{ email: "eve@example.test", status: "invited" }] }));
  await page.submitEmailQuery();
  expect(page.invitationSent()).toBe(true);
  expect(calls.find((call) => call.path === "/api/conversations")?.body).toEqual({ recipients: [{ email: "eve@example.test" }] });
}));

test("failed, uncertain, and non-success replies never show invitation success", () => withFetch(async (calls, respond) => {
  for (const [status, httpStatus] of [["failed", 200], ["uncertain", 200], ["invited", 500]] as const) {
    const { page } = newConversation(calls, respond);
    page.query = "friend@example.test";
    respond(async () => Response.json({ conversation: null, pending: true, recipients: [{ email: page.query, status }] }, { status: httpStatus }));
    await page.submitEmailQuery();
    expect(page.invitationSent()).toBe(false);
  }
}));

test("email query retry preserves its idempotency key after transport failure", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  page.query = "friend@example.test";
  respond(async () => { throw new Error("offline"); });
  await page.submitEmailQuery();
  await page.submitEmailQuery();
  const posts = calls.filter((call) => call.path === "/api/conversations");
  expect(posts).toHaveLength(2);
  expect(posts[1]!.headers["Idempotency-Key"]).toBe(posts[0]!.headers["Idempotency-Key"]);
}));

test("channel email invite submits channel destination and stays in the current channel", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, openedRoom, connected } = newConversation(calls, respond);
  page.openInvite("#garden", "friend@example.test");
  expect(page.destination).toBe("#garden");
  expect(page.isEmailQuery()).toBe(true);
  expect(calls.some((call) => call.path.startsWith("/api/people"))).toBe(false);
  respond(async () => Response.json({ conversation: null, pending: true, recipients: [{ email: "friend@example.test", status: "invited" }] }));
  await page.submitEmailQuery();
  const post = calls.find((call) => call.path === "/api/conversations")!;
  expect(post.body).toEqual({ recipients: [{ email: "friend@example.test" }], destination: { type: "channel", channel: "#garden" } });
  expect(post.headers["Idempotency-Key"]).toMatch(IDEMPOTENCY);
  expect(connected()).toBe(1);
  expect(openedDirect).toEqual([]);
  expect(openedRoom).toEqual([]);
  expect(page.destination).toBeNull();
}));

test("people search accepts an @ prefix without sending it to lookup", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  respond(async () => Response.json({ people: [] }));
  page.query = "@e";
  await page.search();
  expect(calls).toHaveLength(0);
  page.query = "@ev";
  await page.search();
  expect(calls[0]!.path).toBe("/api/people?q=ev&limit=20");
  expect(page.query).toBe("@ev");
}));

test("people search waits for two characters and clears short queries", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  page.query = "e";
  page.results = [{ accountId: "eve-id", nick: "eve", displayName: "Eve", avatarUrl: "" }];
  await page.search();
  expect(calls).toHaveLength(0);
  expect(page.results).toHaveLength(0);
  page.query = "ev";
  respond(async () => Response.json({ people: [] }));
  await page.search();
  expect(calls).toHaveLength(1);
}));

test("a search result supplies verified account identity even outside contacts", () => {
  const opened: unknown[][] = [];
  const { page } = newConversation([], () => {}, {
    openDirect: (nick: string, accountId?: string) => { opened.push([nick, accountId]); },
  });
  page.choosePerson({ accountId: "new-peer-id", nick: "new-peer", displayName: "New peer", avatarUrl: "" });
  expect(opened).toEqual([["new-peer", "new-peer-id"]]);
});

test("group mode chooses into the recipient list instead of opening a DM", () => {
  const { page, openedDirect } = newConversation([], () => {});
  page.setMode("group");
  expect(page.mode).toBe("group");
  page.choosePerson({ accountId: "bob-id", nick: "bob", displayName: "Bob", avatarUrl: "" });
  expect(openedDirect).toEqual([]);
  expect(page.recipients).toHaveLength(1);
  expect((page.recipients[0] as any).accountId).toBe("bob-id");
  page.setMode("direct");
  expect(page.mode).toBe("direct");
  expect(page.recipients).toHaveLength(0);
});

test("a stale search response never overwrites the latest query", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  let releaseFirst!: (value: Response) => void;
  let searches = 0;
  respond(async () => {
    searches += 1;
    if (searches === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
    return Response.json({ people: [{ accountId: "new-id", nick: "new", displayName: "New", avatarUrl: "" }] });
  });
  page.query = "old"; const first = page.search();
  page.query = "new"; const second = page.search();
  await second;
  releaseFirst(Response.json({ people: [{ accountId: "old-id", nick: "old", displayName: "Old", avatarUrl: "" }] }));
  await first;
  expect(page.results.map((person: any) => person.accountId)).toEqual(["new-id"]);
}));

test("status label and recipient payload read from the selection", () => {
  expect(newConversationStatusLabel("uncertain")).toBe("Delivery uncertain");
  expect(validNewConversationPerson({ accountId: "a", nick: "b", displayName: "c" })).toBe(true);
  expect(validNewConversationPerson({ nick: "b" })).toBe(false);
  expect(conversationRecipientKey([{ kind: "email", email: "A@Example.com" }])).toBe(JSON.stringify([{ email: "A@Example.com" }]));
  expect(recipientPayload([{ kind: "account", accountId: "x", nick: "x", displayName: "x" }])).toEqual([{ accountId: "x" }]);
});

// ---------------------------------------------------------------------------
// Sent invitations page
// ---------------------------------------------------------------------------

function invitationsPage(calls: Call[], respond: (fn: (call: Call) => Promise<Response>) => void, key = "acct-1") {
  const page = createInvitationsPage((value) => value, { core: { authenticated: true }, session: session(key) });
  respond(async (call) => {
    if (call.path === "/api/invitations") return Response.json({ remaining: 9, limit: 9, invitations: [
      { id: "inv-1", recipientEmail: "a@example.com", destination: { type: "dm", channel: null }, status: "pending", createdAt: 1, expiresAt: Date.now() + 1000, sends: 1 },
    ] });
    return Response.json({ error: "no response set" }, { status: 500 });
  });
  return page;
}

test("load reads invitations and the remaining allowance", () => withFetch(async (calls, respond) => {
  const page = invitationsPage(calls, respond);
  await page.load();
  expect(page.invitations).toHaveLength(1);
  expect(page.invitations[0]!.recipientEmail).toBe("a@example.com");
  expect(page.remaining).toBe(9);
  expect(page.limit).toBe(9);
}));

test("resend posts with an idempotency key and maps sent to pending", () => withFetch(async (calls, respond) => {
  const page = invitationsPage(calls, respond);
  await page.load();
  respond(async () => Response.json({ id: "inv-1", status: "sent", expiresAt: Date.now() + 2000, remaining: 8, limit: 9 }));
  await page.resend(page.invitations[0]!);
  const post = calls.find((call) => call.path === "/api/invitations/inv-1/resend")!;
  expect(post.method).toBe("POST");
  expect(post.headers["Idempotency-Key"]).toMatch(IDEMPOTENCY);
  expect(page.invitations[0]!.status).toBe("pending");
  expect(page.invitations[0]!.sends).toBe(2);
  expect(page.remaining).toBe(8);
}));

test("a verified email match on resend becomes accepted without another email", () => withFetch(async (calls, respond) => {
  const page = invitationsPage(calls, respond);
  await page.load();
  respond(async () => Response.json({ status: "added", accountId: "bob-id", nick: "bob", remaining: 9, limit: 9 }));
  await page.resend(page.invitations[0]!);
  expect(page.invitations[0]!.status).toBe("accepted");
  expect(page.remaining).toBe(9);
}));

test("resend transport failure reuses the same idempotency key on retry", () => withFetch(async (calls, respond) => {
  const page = invitationsPage(calls, respond);
  await page.load();
  let attempt = 0;
  respond(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("network down");
    return Response.json({ id: "inv-1", status: "sent", expiresAt: Date.now() + 2000, remaining: 8, limit: 9 });
  });
  await page.resend(page.invitations[0]!);
  await page.resend(page.invitations[0]!);
  const keys = calls.filter((call) => call.path.endsWith("/resend")).map((call) => call.headers["Idempotency-Key"]);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
}));

test("cancel deletes only the invitation and marks it cancelled", () => withFetch(async (calls, respond) => {
  const page = invitationsPage(calls, respond);
  await page.load();
  respond(async () => new Response(null, { status: 204 }));
  await page.cancel(page.invitations[0]!);
  const del = calls.find((call) => call.method === "DELETE")!;
  expect(del.path).toBe("/api/invitations/inv-1");
  expect(page.invitations[0]!.status).toBe("cancelled");
  expect(page.invitations[0]!.recipientEmail).toBe("a@example.com"); // row retained, never a membership delete
}));

test("invitation labels and eligibility", () => {
  expect(invitationStatusLabel("pending")).toBe("Pending");
  expect(invitationStatusLabel("uncertain")).toBe("Delivery uncertain");
  expect(invitationDestinationLabel({ destination: { type: "dm", channel: null } })).toBe("Direct message");
  expect(invitationDestinationLabel({ destination: { type: "group", channel: "#g-abc" } })).toBe("#g-abc");
  expect(canResendInvitation("expired")).toBe(true);
  expect(canResendInvitation("accepted")).toBe(false);
  expect(canCancelInvitation("cancelled")).toBe(false);
  expect(invitationDate(0)).toBe("");
});

// ---------------------------------------------------------------------------
// Route and partial integration
// ---------------------------------------------------------------------------

test("invitations is a real route with no conversation id", () => {
  const ORIGIN = "https://app.slirc.org";
  expect(routeUrl({ kind: "invitations" })).toBe("/invitations");
  expect(parseRoute("/invitations", ORIGIN)).toEqual({ kind: "invitations" });
  expect(parseRoute("/invitations/extra", ORIGIN)).toBeNull();
  expect(resolveConversationId({ kind: "invitations" })).toBeNull();
});

test("/prelaunch is only a route alias for invitations", () => {
  const ORIGIN = "https://app.slirc.org";
  expect(parseRoute("/prelaunch", ORIGIN)).toEqual({ kind: "invitations" });
  expect(parseRoute("/prelaunch/extra", ORIGIN)).toBeNull();
});

// ---------------------------------------------------------------------------
// Invitation landing / acceptance
// ---------------------------------------------------------------------------

test("joinDestinationLabel distinguishes email invites from copied links", () => {
  expect(joinDestinationLabel({ requiresVerifiedEmail: true, destination: { type: "dm", channel: null } })).toBe("a private conversation");
  expect(joinDestinationLabel({ requiresVerifiedEmail: true, destination: { type: "group", channel: "#g-abc" } })).toBe("#g-abc");
  expect(joinDestinationLabel({ channel: "#watercooler" })).toBe("#watercooler");
  expect(joinDestinationLabel(null)).toBe("this conversation");
});

function acceptComponent(calls: Call[], respond: (fn: (call: Call) => Promise<Response>) => void, overrides: Record<string, unknown> = {}) {
  const openedDirect: string[] = [];
  const openedRoom: string[] = [];
  let homes = 0;
  let logouts = 0;
  let connected = 0;
  let currentKey = "acct-1";
  let accountId = "acct-1";
  const page = createInvitationAccept((value) => value, {
    session: { scope: () => ({ instance: "https://slirc.example.test", account: "eve", accountId: currentKey }), key: () => currentKey, stopped: () => false, signingOut: () => false },
    connect: async () => { connected += 1; },
    openDirect: (nick) => { openedDirect.push(nick); },
    openRoom: (room) => { openedRoom.push(room); },
    goHome: () => { homes += 1; },
    logout: () => { logouts += 1; },
    authenticatedAccountId: () => accountId,
    destinationReachable: () => true,
    ...overrides,
  });
  respond(async (call) => {
    if (call.path === "/api/join/invite-token") return Response.json({ destination: { type: "dm", channel: null }, requiresVerifiedEmail: true });
    return Response.json({ error: "no response set" }, { status: 500 });
  });
  return {
    page, openedDirect, openedRoom, homes: () => homes, logouts: () => logouts, connected: () => connected,
    setKey: (next: string) => { currentKey = next; }, setAccountId: (next: string) => { accountId = next; },
  };
}

test("start loads join info and recognizes an email invite", () => withFetch(async (calls, respond) => {
  const { page } = acceptComponent(calls, respond);
  await page.start("invite-token");
  expect(calls[0]!.path).toBe("/api/join/invite-token");
  expect(page.isEmailInvite()).toBe(true);
  expect(page.destinationLabel()).toBe("a private conversation");
  await page.start("invite-token");
  expect(calls).toHaveLength(1); // same token and already loaded: no refetch
}));

test("email-invite signup sends only the token and name, never an email", () => withFetch(async (calls, respond) => {
  const { page } = acceptComponent(calls, respond);
  await page.start("invite-token");
  respond(async () => Response.json({ sent: true }, { status: 202 }));
  page.name = "  Wolff  ";
  await page.requestSignup();
  const post = calls.find((call) => call.path === "/auth/invitation/request")!;
  expect(post.method).toBe("POST");
  expect(post.body).toEqual({ token: "invite-token", name: "Wolff" });
  expect(Object.keys(post.body)).toEqual(["token", "name"]);
  expect(post.headers["X-Slirc-Invitation"]).toBe("1");
  expect(page.signupSent).toBe(true);
  expect(page.devLink).toBe("");
}));

test("a new address signed in by signup connects and accepts without a second email", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, connected } = acceptComponent(calls, respond);
  await page.start("invite-token");
  respond(async (call) => {
    if (call.path === "/auth/invitation/request") return Response.json({ signedIn: true, accountId: "acct-new", nick: "wolff" });
    if (call.path === "/api/join/invite-token" && call.method === "POST") return Response.json({ type: "direct", channel: "#dm-bob", nick: "bob", accepted: true });
    return Response.json({});
  });
  page.name = "Wolff";
  await page.requestSignup();
  expect(page.signupSent).toBe(false);
  expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/auth/invitation/request", "/api/join/invite-token"]);
  expect(connected()).toBeGreaterThanOrEqual(1);
  expect(openedDirect).toEqual(["bob"]);
  expect(page.signupBusy).toBe(false);
}));

test("a code answer for the previous invitation is dropped once another invitation opens", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, connected } = acceptComponent(calls, respond);
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  respond(async (call) => {
    if (call.path === "/auth/invitation/request") return Response.json({ sent: true }, { status: 202 });
    if (call.path === "/auth/code") return held;
    if (call.method === "POST") return Response.json({ type: "direct", nick: "bob", accepted: true });
    return Response.json({ destination: { type: "dm", channel: null }, requiresVerifiedEmail: true });
  });
  await page.start("token-a");
  page.name = "Wolff";
  await page.requestSignup();
  page.code = "246802";
  const submitted = page.submitCode();
  expect(page.codeBusy).toBe(true);
  await page.start("token-b");
  // The new invitation starts clean and usable while the old answer is still in flight.
  expect(page.codeBusy).toBe(false);
  expect(page.signupSent).toBe(false);
  release(Response.json({ next: "/" }));
  await submitted;
  expect(page.token).toBe("token-b");
  expect(connected()).toBe(0);
  expect(openedDirect).toEqual([]);
  expect(calls.some((call) => call.method === "POST" && call.path.startsWith("/api/join/"))).toBe(false);
}));

test("a good code followed by a failed account load shows a visible error", () => withFetch(async (calls, respond) => {
  const { page } = acceptComponent(calls, respond, { connect: async () => { throw new Error("offline"); } });
  await page.start("invite-token");
  respond(async (call) => {
    if (call.path === "/auth/invitation/request") return Response.json({ sent: true }, { status: 202 });
    if (call.path === "/auth/code") return Response.json({ next: "/" });
    return Response.json({});
  });
  page.name = "Wolff";
  await page.requestSignup();
  page.code = "246802";
  await page.submitCode();
  // The code form is gone (the code is spent), so the message sits in the always-visible slot.
  expect(page.signupSent).toBe(false);
  expect(page.codeError).toBe("");
  expect(page.acceptError).toContain("Reload");
  expect(page.codeBusy).toBe(false);
}));

test("an existing account types the mailed code with only the token, then accepts", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, connected } = acceptComponent(calls, respond);
  await page.start("invite-token");
  let codeStatus = 400;
  respond(async (call) => {
    if (call.path === "/auth/invitation/request") return Response.json({ sent: true }, { status: 202 });
    if (call.path === "/auth/code") return codeStatus === 200 ? Response.json({ next: "/" }) : Response.json({ error: "Wrong code. Try again." }, { status: 400 });
    if (call.path === "/api/join/invite-token" && call.method === "POST") return Response.json({ type: "direct", channel: "#dm-bob", nick: "bob", accepted: true });
    return Response.json({});
  });
  // Nothing is posted before the sign-in mail was requested, or for a short code.
  page.code = "123456";
  await page.submitCode();
  page.name = "Wolff";
  await page.requestSignup();
  page.code = "12a3";
  page.codeInput();
  expect(page.code).toBe("123");
  await page.submitCode();
  expect(page.codeError).toBe("Enter the 6-digit code.");
  expect(calls.some((call) => call.path === "/auth/code")).toBe(false);
  // A wrong code shows the server's message, clears the field, and stays on the code step.
  page.code = "000000";
  await page.submitCode();
  expect(page.codeError).toBe("Wrong code. Try again.");
  expect(page.code).toBe("");
  expect(page.signupSent).toBe(true);
  expect(connected()).toBe(0);
  // The sixth digit submits. Only the token and code travel, with the invitation header.
  codeStatus = 200;
  page.code = "246802";
  page.codeInput();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const post = calls.filter((call) => call.path === "/auth/code").at(-1)!;
  expect(post.body).toEqual({ invitation: "invite-token", code: "246802" });
  expect(post.headers["X-Slirc-Invitation"]).toBe("1");
  expect(page.signupSent).toBe(false);
  expect(connected()).toBeGreaterThanOrEqual(1);
  expect(calls.filter((call) => call.method === "POST").map((call) => call.path).slice(-2)).toEqual(["/auth/code", "/api/join/invite-token"]);
  expect(openedDirect).toEqual(["bob"]);
  expect(page.codeBusy).toBe(false);
}));

test("local dev returns a devLink, production returns only the sent state", () => withFetch(async (calls, respond) => {
  const { page } = acceptComponent(calls, respond);
  await page.start("invite-token");
  respond(async () => Response.json({ devLink: "http://localhost/auth/verify?token=abc" }, { status: 202 }));
  page.name = "Wolff";
  await page.requestSignup();
  expect(page.signupSent).toBe(true);
  expect(page.devLink).toContain("/auth/verify?token=abc");
}));

test("signup requires a name and refuses on a copied link", () => withFetch(async (calls, respond) => {
  const { page } = acceptComponent(calls, respond);
  await page.start("invite-token");
  page.name = "   ";
  await page.requestSignup();
  expect(page.acceptError).toContain("display name");
  expect(calls.some((call) => call.path === "/auth/invitation/request")).toBe(false);
}));

test("accept posts, refreshes the mapping, then opens the pair DM", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, connected } = acceptComponent(calls, respond);
  await page.start("invite-token");
  respond(async (call) => call.path === "/api/join/invite-token" && call.method === "POST"
    ? Response.json({ type: "direct", channel: "#dm-bob", nick: "bob", accepted: true })
    : Response.json({}));
  await page.accept();
  expect(connected()).toBe(1);
  expect(openedDirect).toEqual(["bob"]);
}));

test("accept opens a group/channel destination", () => withFetch(async (calls, respond) => {
  const { page, openedRoom } = acceptComponent(calls, respond);
  await page.start("invite-token");
  respond(async (call) => call.method === "POST" ? Response.json({ type: "group", channel: "#g-abc", accepted: true }) : Response.json({}));
  await page.accept();
  expect(openedRoom).toEqual(["#g-abc"]);
}));

test("a copied room link accepts through the same call and opens the channel", () => withFetch(async (calls, respond) => {
  const { page, openedRoom } = acceptComponent(calls, respond);
  respond(async (call) => call.path === "/api/join/copied" ? Response.json({ channel: "#watercooler" }) : Response.json({}));
  await page.start("copied");
  expect(page.isEmailInvite()).toBe(false);
  await page.accept();
  expect(openedRoom).toEqual(["#watercooler"]);
  page.name = "X";
  await page.requestSignup();
  expect(calls.some((call) => call.path === "/auth/invitation/request")).toBe(false);
}));

test("a wrong signed-in account is explained and offered a switch, never auto-claimed", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, openedRoom, logouts } = acceptComponent(calls, respond);
  await page.start("invite-token");
  respond(async (call) => call.method === "POST" ? Response.json({ error: "sign in with the verified invited email" }, { status: 403 }) : Response.json({}));
  await page.accept();
  expect(page.accountMismatch).toBe(true);
  expect(page.acceptError).toContain("verified invited email");
  expect(openedDirect).toEqual([]);
  expect(openedRoom).toEqual([]);
  page.switchAccount();
  expect(logouts()).toBe(1);
  expect(page.accountMismatch).toBe(false);
}));

test("a transport error during accept is reported and cancel returns home", () => withFetch(async (calls, respond) => {
  const { page, homes } = acceptComponent(calls, respond);
  await page.start("invite-token");
  respond(async () => { throw new Error("network down"); });
  await page.accept();
  expect(page.acceptError).toContain("network down");
  page.goHome();
  expect(homes()).toBe(1);
}));

test("a zero-conversation invitee can accept once the mapping refreshes", () => withFetch(async (calls, respond) => {
  // The zero-conversation bootstrap opens the first real account scope inside connect(). The
  // acceptance must compare the immutable account id, not the pre-refresh scope key.
  let reachable = false;
  const harness = acceptComponent(calls, respond, {
    destinationReachable: () => reachable,
    connect: async () => { harness.setKey("acct-1"); reachable = true; },
  });
  harness.setKey(""); // denied-but-authenticated: no scope opened yet
  await harness.page.start("invite-token");
  expect(harness.page.info).not.toBeNull();
  expect(harness.page.loading).toBe(false);
  respond(async (call) => call.method === "POST" ? Response.json({ type: "group", channel: "#g-zero", accepted: true }) : Response.json({}));
  await harness.page.accept();
  expect(harness.openedRoom).toEqual(["#g-zero"]);
  expect(harness.page.busy).toBe(false);
}));

test("public join info survives the account scope opening mid-fetch", () => withFetch(async (calls, respond) => {
  let release!: (response: Response) => void;
  const harness = acceptComponent(calls, respond);
  respond(() => new Promise<Response>((resolve) => { release = resolve; }));
  harness.setKey("");
  const loading = harness.page.start("invite-token");
  harness.setKey("acct-1"); // scope opens while the public fetch is still in flight
  release(Response.json({ destination: { type: "dm", channel: null }, requiresVerifiedEmail: true }));
  await loading;
  expect(harness.page.info).not.toBeNull();
  expect(harness.page.loading).toBe(false);
}));

test("an unrelated account switch during accept aborts navigation and clears busy", () => withFetch(async (calls, respond) => {
  let release!: (response: Response) => void;
  const harness = acceptComponent(calls, respond);
  await harness.page.start("invite-token");
  respond(async (call) => call.method === "POST" ? new Promise<Response>((resolve) => { release = resolve; }) : Response.json({}));
  const accepting = harness.page.accept();
  harness.setAccountId("someone-else");
  release(Response.json({ type: "group", channel: "#g-other", accepted: true }));
  await accepting;
  expect(harness.openedRoom).toEqual([]);
  expect(harness.page.busy).toBe(false);
}));

test("sign-in next preserves the join path so verification returns to acceptance", () => {
  const ORIGIN = "https://app.slirc.org";
  expect(signInNext(routeFromMount("/join/invite-token", ""), ORIGIN)).toBe("/join/invite-token");
  expect(signInNext(routeFromMount("/join/invite-token", "", "?x=1"), ORIGIN)).toBe("/join/invite-token");
});

// ---------------------------------------------------------------------------
// Ambiguous-outcome idempotency
// ---------------------------------------------------------------------------

test("conversationOutcomeIsRecorded only trusts definite server outcomes", () => {
  expect(conversationOutcomeIsRecorded(409, { error: "request outcome is still being recovered; retry with the same key" })).toBe(false);
  expect(conversationOutcomeIsRecorded(409, { error: "idempotency key reused with different payload" })).toBe(true);
  expect(conversationOutcomeIsRecorded(200, null)).toBe(false);
  expect(conversationOutcomeIsRecorded(200, { conversation: null, pending: true, recipients: [] })).toBe(true);
  expect(conversationOutcomeIsRecorded(502, { recipients: [{ status: "failed" }] })).toBe(true);
  expect(conversationOutcomeIsRecorded(500, {})).toBe(false);
  expect(conversationOutcomeIsRecorded(400, { error: "one to twenty recipients required" })).toBe(true);
});

test("resendOutcomeIsRecorded keeps the key for a processing 409 only", () => {
  expect(resendOutcomeIsRecorded(409, { error: "request outcome is still being recovered; retry with the same key" })).toBe(false);
  expect(resendOutcomeIsRecorded(409, { error: "invitation delivery is uncertain; refusing blind resend", status: "uncertain" })).toBe(true);
  expect(resendOutcomeIsRecorded(200, { status: "sent" })).toBe(true);
  expect(resendOutcomeIsRecorded(502, {})).toBe(false);
  expect(resendOutcomeIsRecorded(200, null)).toBe(false);
});

test("a processing 409 keeps the frozen key and retry replays the same request", () => withFetch(async (calls, respond) => {
  const { page, openedRoom } = newConversation(calls, respond);
  let attempt = 0;
  respond(async () => {
    attempt += 1;
    if (attempt === 1) return Response.json({ error: "request outcome is still being recovered; retry with the same key" }, { status: 409 });
    return Response.json({ conversation: { type: "group", channel: "#g-1" }, recipients: [{ accountId: "bob-id", nick: "bob", status: "added" }], remaining: 9, limit: 9 });
  });
  page.addPerson({ accountId: "bob-id", nick: "bob", displayName: "Bob", avatarUrl: "" });
  await page.submit();
  expect(page.error).toContain("still being recovered");
  expect(page.settled).toBe(false);
  expect(openedRoom).toEqual([]);
  await page.submit();
  const posts = calls.filter((call) => call.path === "/api/conversations");
  expect(posts).toHaveLength(2);
  expect(posts[0]!.headers["Idempotency-Key"]).toBe(posts[1]!.headers["Idempotency-Key"]);
  expect(openedRoom).toEqual(["#g-1"]);
}));

test("a malformed reply keeps the key, never navigates, and retries the same request", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, openedRoom } = newConversation(calls, respond);
  let attempt = 0;
  respond(async () => {
    attempt += 1;
    if (attempt === 1) return new Response("gateway", { status: 200 });
    return Response.json({ conversation: { type: "direct", channel: "#dm-bob", nick: "bob" }, recipients: [{ accountId: "bob-id", nick: "bob", status: "added" }], remaining: 9, limit: 9 });
  });
  page.addPerson({ accountId: "bob-id", nick: "bob", displayName: "Bob", avatarUrl: "" });
  await page.submit();
  expect(page.error).toContain("usable reply");
  expect(page.settled).toBe(false);
  expect(openedDirect).toEqual([]);
  expect(openedRoom).toEqual([]);
  await page.submit();
  const keys = calls.filter((call) => call.path === "/api/conversations").map((call) => call.headers["Idempotency-Key"]);
  expect(keys[0]).toBe(keys[1]);
  expect(openedDirect).toEqual(["bob"]);
}));

test("a 5xx with no outcome is ambiguous and keeps the key", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  let attempt = 0;
  respond(async () => {
    attempt += 1;
    if (attempt === 1) return Response.json({ error: "gateway timeout" }, { status: 504 });
    return Response.json({ conversation: null, pending: true, recipients: [{ email: "a@example.com", status: "invited", invitationId: "i1" }], remaining: 8, limit: 9 });
  });
  page.emailInput = "a@example.com"; page.addEmail();
  await page.submit();
  await page.submit();
  const keys = calls.filter((call) => call.path === "/api/conversations").map((call) => call.headers["Idempotency-Key"]);
  expect(keys[0]).toBe(keys[1]);
}));

test("a sole failed email is not reported as sent and never navigates", () => withFetch(async (calls, respond) => {
  const { page, openedDirect, openedRoom } = newConversation(calls, respond);
  respond(async () => Response.json({
    conversation: null, pending: true,
    recipients: [{ email: "gone@example.com", status: "failed", invitationId: "inv-2", error: "mailbox rejected" }],
    remaining: 9, limit: 9,
  }, { status: 207 }));
  page.emailInput = "gone@example.com"; page.addEmail();
  await page.submit();
  expect(page.note).not.toContain("Invitation sent");
  expect(page.note).toContain("could not be delivered");
  expect(page.settled).toBe(true);
  expect(openedDirect).toEqual([]);
  expect(openedRoom).toEqual([]);
}));

test("a sole uncertain email warns instead of claiming it was sent", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  respond(async () => Response.json({
    conversation: null, pending: true,
    recipients: [{ email: "maybe@example.com", status: "uncertain", invitationId: "inv-3" }],
    remaining: 9, limit: 9,
  }, { status: 207 }));
  page.emailInput = "maybe@example.com"; page.addEmail();
  await page.submit();
  expect(page.note).toContain("uncertain");
  expect(page.note).not.toContain("Invitation sent");
}));

test("selection handlers are frozen while a request is in flight", () => withFetch(async (calls, respond) => {
  const { page } = newConversation(calls, respond);
  let release!: (response: Response) => void;
  respond(async () => new Promise<Response>((resolve) => { release = resolve; }));
  page.addPerson({ accountId: "bob-id", nick: "bob", displayName: "Bob", avatarUrl: "" });
  const submitting = page.submit();
  expect(page.busy).toBe(true);
  page.addPerson({ accountId: "carol-id", nick: "carol", displayName: "Carol", avatarUrl: "" });
  page.emailInput = "x@example.com"; page.addEmail();
  page.removeRecipient(0);
  expect(page.recipients).toHaveLength(1);
  release(Response.json({ conversation: { type: "direct", channel: "#dm-bob", nick: "bob" }, recipients: [{ accountId: "bob-id", nick: "bob", status: "added" }], remaining: 9, limit: 9 }));
  await submitting;
}));

test("a resend processing 409 keeps the same key on retry", () => withFetch(async (calls, respond) => {
  const page = invitationsPage(calls, respond);
  await page.load();
  let attempt = 0;
  respond(async () => {
    attempt += 1;
    if (attempt === 1) return Response.json({ error: "request outcome is still being recovered; retry with the same key" }, { status: 409 });
    return Response.json({ id: "inv-1", status: "sent", expiresAt: Date.now() + 2000, remaining: 8, limit: 9 });
  });
  await page.resend(page.invitations[0]!);
  await page.resend(page.invitations[0]!);
  const keys = calls.filter((call) => call.path.endsWith("/resend")).map((call) => call.headers["Idempotency-Key"]);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(page.invitations[0]!.status).toBe("pending");
}));

// New DM from the keyboard: with one match Enter opens it; arrows pick among several.
const key = (name: string) => ({ key: name, isComposing: false, preventDefault() {} }) as unknown as KeyboardEvent;
const people = (...nicks: string[]) => Response.json({ people: nicks.map((nick) => ({ accountId: `${nick}-id`, nick, displayName: nick, avatarUrl: "" })) });

test("Enter opens the only search result, even before the debounced search ran", () => withFetch(async (calls, respond) => {
  const { page, openedDirect } = newConversation(calls, respond);
  respond(async (call) => call.path.startsWith("/api/people") ? people("help") : Response.json({}));
  page.query = "help";
  await page.keydown(key("Enter"));
  expect(calls.filter((call) => call.path.startsWith("/api/people")).length).toBe(1);
  expect(openedDirect).toEqual(["help"]);
}));

test("arrow keys move the highlight and Enter opens that person", () => withFetch(async (calls, respond) => {
  const { page, openedDirect } = newConversation(calls, respond);
  respond(async (call) => call.path.startsWith("/api/people") ? people("ada", "ben", "bob") : Response.json({}));
  page.query = "b";
  page.query = "bo";
  await page.search();
  expect(page.active).toBe(0);
  await page.keydown(key("ArrowDown"));
  await page.keydown(key("ArrowDown"));
  expect(page.active).toBe(2);
  await page.keydown(key("ArrowDown"));
  expect(page.active).toBe(0);
  await page.keydown(key("ArrowUp"));
  expect(page.active).toBe(2);
  await page.keydown(key("Enter"));
  // The results were already fresh, so Enter did not search again.
  expect(calls.filter((call) => call.path.startsWith("/api/people")).length).toBe(1);
  expect(openedDirect).toEqual(["bob"]);
}));

test("Enter with no results, or on an email address, opens nothing", () => withFetch(async (calls, respond) => {
  const { page, openedDirect } = newConversation(calls, respond);
  respond(async (call) => call.path.startsWith("/api/people") ? people() : Response.json({}));
  page.query = "zz";
  await page.keydown(key("Enter"));
  page.query = "new@example.test";
  await page.keydown(key("Enter"));
  expect(openedDirect).toEqual([]);
}));

test("before typing, Enter opens the highlighted contact", () => withFetch(async (calls, respond) => {
  const { page, openedDirect } = newConversation(calls, respond);
  await page.keydown(key("ArrowDown"));
  await page.keydown(key("Enter"));
  expect(openedDirect).toEqual(["carol"]);
}));

// Joining from a new address takes seconds (the server opens the help DM before it answers). The
// button spins from the press until the channel opens, with no idle moment between sign-in,
// connect and accept.
test("a new address joining keeps the button busy through sign-in, connect and accept", () => withFetch(async (calls, respond) => {
  const seen: [string, boolean][] = [];
  let pageRef: { working(): boolean } | null = null;
  const { page } = acceptComponent(calls, respond, {
    connect: async () => { seen.push(["connect", pageRef!.working()]); },
    openRoom: (room: string) => { seen.push([`open ${room}`, pageRef!.working()]); },
  });
  pageRef = page;
  await page.start("invite-token");
  expect(page.working()).toBe(false);
  respond(async (call) => {
    if (call.path === "/auth/invitation/request") { seen.push(["signup", page.working()]); return Response.json({ signedIn: true, accountId: "acct-1", nick: "eve" }); }
    if (call.path === "/api/join/invite-token" && call.method === "POST") { seen.push(["accept", page.working()]); return Response.json({ type: "channel", channel: "#dev-test", accepted: true }); }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  page.name = "Eve";
  await page.requestSignup();
  expect(seen).toEqual([["signup", true], ["connect", true], ["accept", true], ["connect", true], ["open #dev-test", true]]);
  expect(page.working()).toBe(false);
}));

test("a typed code keeps the button busy through sign-in, connect and accept", () => withFetch(async (calls, respond) => {
  const seen: [string, boolean][] = [];
  let pageRef: { working(): boolean } | null = null;
  const { page } = acceptComponent(calls, respond, {
    connect: async () => { seen.push(["connect", pageRef!.working()]); },
    openRoom: (room: string) => { seen.push([`open ${room}`, pageRef!.working()]); },
  });
  pageRef = page;
  await page.start("invite-token");
  page.signupSent = true;
  page.code = "123456";
  respond(async (call) => {
    if (call.path === "/auth/code") { seen.push(["code", page.working()]); return Response.json({ next: "/" }); }
    if (call.path === "/api/join/invite-token" && call.method === "POST") { seen.push(["accept", page.working()]); return Response.json({ type: "channel", channel: "#dev-test", accepted: true }); }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  await page.submitCode();
  expect(seen).toEqual([["code", true], ["connect", true], ["accept", true], ["connect", true], ["open #dev-test", true]]);
  expect(page.working()).toBe(false);
}));

// People page: current items first, past ones behind "Show past"; join link rows read as one line.
test("past invitations and links fold away, and join link rows say what matters", async () => {
  const { createInvitationsPage, isPastInvitation, isPastJoinLink, joinLinkDetail, joinLinkDisplay, joinLinkProgress } = await import("@client/invitations-page.ts");
  expect(["accepted", "cancelled", "expired"].every((status) => isPastInvitation({ status }))).toBe(true);
  expect(["pending", "sending", "failed", "uncertain"].some((status) => isPastInvitation({ status }))).toBe(false);
  const day = 86_400_000;
  const open = { id: "a", channel: "#dev", joins: 12, maxJoins: 50, expiresAt: Date.UTC(2026, 10, 18), revoked: false, state: "open" as const };
  const revoked = { ...open, id: "b", revoked: true, state: "closed" as const };
  const expired = { ...open, id: "c", expiresAt: Date.now() - day, state: "closed" as const };
  expect(isPastJoinLink(open)).toBe(false);
  expect(isPastJoinLink(revoked) && isPastJoinLink(expired)).toBe(true);
  expect(joinLinkDetail(open)).toMatch(/^12 of 50 joined · closes /);
  expect(joinLinkDetail(revoked)).toBe("12 of 50 joined");
  expect(joinLinkDetail({ ...open, joins: 50, state: "full" })).toBe("50 of 50 joined · full");
  expect(joinLinkProgress(open)).toBe(24);
  expect(joinLinkDisplay("https://ai-guild.slirc.app/j/auCeojwiFaBBs-z3Qk9rT2vLmN0pXyZa")).toBe("ai-guild.slirc.app/j/auCeojwi…");
  const page = createInvitationsPage((value) => value, { core: { authenticated: true } as never, session: session() as never });
  page.joinLinks = [revoked, open, expired];
  page.invitations = [{ id: "i1", status: "accepted" }, { id: "i2", status: "pending" }, { id: "i3", status: "expired" }] as never;
  expect(page.visibleJoinLinks().map((link) => link.id)).toEqual(["a"]);
  expect(page.pastJoinLinkCount()).toBe(2);
  expect(page.visibleInvitations().map((row) => row.id)).toEqual(["i2"]);
  expect(page.pastInvitationCount()).toBe(2);
  page.showPastLinks = true; page.showPastInvitations = true;
  expect(page.visibleJoinLinks().map((link) => link.id)).toEqual(["a", "b", "c"]);
  expect(page.visibleInvitations().map((row) => row.id)).toEqual(["i2", "i1", "i3"]);
});

test("a listed join link copies its whole URL and says Copied; an older one cannot be copied", async () => {
  const { createInvitationsPage, joinLinkUncopyable } = await import("@client/invitations-page.ts");
  const url = "https://ai-guild.slirc.app/j/auCeojwiFaBBs-z3Qk9rT2vLmN0pXyZa";
  const open = { id: "a", channel: "#dev", joins: 0, maxJoins: 50, expiresAt: Date.now() + 86_400_000, revoked: false, state: "open" as const, url };
  const older = { ...open, id: "b", url: null };
  expect(joinLinkUncopyable(open)).toBe(false);
  expect(joinLinkUncopyable(older)).toBe(true);
  expect(joinLinkUncopyable({ ...older, revoked: true, state: "closed" })).toBe(false);
  const written: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  try {
    const page = createInvitationsPage((value) => value, { core: { authenticated: true } as never, session: session() as never });
    await page.copyListedJoinLink(open);
    expect(written).toEqual([url]);
    expect(page.joinCopiedId).toBe("a");
    await page.copyListedJoinLink(older);
    expect(written).toEqual([url]);
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    await page.copyListedJoinLink(open);
    expect(page.joinUrl).toBe(url);
    expect(page.joinCopyFailed).toBe(true);
  } finally {
    if (clipboard) Object.defineProperty(globalThis.navigator, "clipboard", clipboard); else delete (globalThis.navigator as any).clipboard;
  }
});

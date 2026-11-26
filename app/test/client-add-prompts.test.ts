// Inline Add / Dismiss prompt for /invite, helper mentions and people mentions: when it appears, what
// Add sends, how Dismiss and errors read, and the transcript markup that renders it. No browser, no network.
import { expect, test } from "bun:test";
import { createAddPrompts, mentionedHelpers, mentionedPeople } from "@client/add-prompts.ts";

interface Call { path: string; method: string; body: any }

async function withFetch(run: (calls: Call[], respond: (fn: (call: Call) => Response | Promise<Response>) => void) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const calls: Call[] = [];
  let responder: (call: Call) => Response | Promise<Response> = () => Response.json({ error: "no response set" }, { status: 500 });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (path: string, init?: RequestInit) => {
      const call: Call = { path, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      return responder(call);
    },
  });
  try { await run(calls, (fn) => { responder = fn; }); }
  finally { if (saved) Object.defineProperty(globalThis, "fetch", saved); else Reflect.deleteProperty(globalThis, "fetch"); }
}

function setup(serverIds: Record<string, string> = { "m-1": "msg-1" }) {
  let focus = 0;
  const prompts = createAddPrompts((value) => value, {
    session: { scope: () => null, key: () => "acct-1", stopped: () => false, signingOut: () => false },
    self: () => "eve",
    serverIdFor: (id) => serverIds[id],
    nextTick: async (callback) => { callback?.(); },
    reveal: () => {},
    restoreFocus: () => { focus++; },
  });
  return { prompts, serverIds, focused: () => focus };
}

const mention = { conversationId: "c-1", channel: "#dev-open", place: "channel" as const, messageId: "m-1", announce: false };
const invite = { conversationId: "c-1", channel: "#dev-test", place: "channel" as const, announce: true };

test("finds explicit helper mentions only", () => {
  expect(mentionedHelpers("@poll lunch? and @Poll? also @help")).toEqual(["poll", "help"]);
  // remind never prompts: a leading @remind is a private /remind.
  expect(mentionedHelpers("@remind in 1m hi")).toEqual([]);
  expect(mentionedHelpers("remind me, mail@poll.test, @poller, @welcome")).toEqual([]);
});

test("a helper mention outside the channel shows Add and Ignore under that message", () => withFetch(async (calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ channel: "#dev-open", nick: "poll", kind: "bot", member: false }));
  await prompts.offer({ ...mention, nick: "poll" });
  expect(calls).toEqual([{ path: "/api/channels/%23dev-open/members/poll", method: "GET", body: null }]);
  const [prompt] = prompts.forMessage("m-1");
  expect(prompt).toMatchObject({ nick: "poll", state: "ask", text: "@poll isn't in #dev-open." });
  expect(prompts.label(prompt!)).toBe("Add");
  expect(prompts.forEnd("c-1")).toEqual([]);
  expect(prompts.canAdd(prompt!)).toBe(true);
}));

test("no prompt when the helper is already a member", () => withFetch(async (_calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ channel: "#dev-open", nick: "poll", kind: "bot", member: true }));
  await prompts.offer({ ...mention, nick: "poll" });
  expect(prompts.items).toEqual([]);
}));

test("/invite @nick shows the prompt at the end, or says they are already here", () => withFetch(async (_calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ channel: "#dev-test", nick: "ada", kind: "human", member: false }));
  await prompts.offer({ ...invite, nick: "@ada" });
  expect(prompts.forEnd("c-1")).toMatchObject([{ nick: "ada", messageId: null, state: "ask", text: "Add @ada to #dev-test?" }]);
  expect(prompts.segments(prompts.forEnd("c-1")[0]!)).toEqual([{ text: "Add " }, { nick: "ada" }, { text: " to #dev-test?" }]);
  respond(() => Response.json({ channel: "#dev-test", nick: "eve2", kind: "human", member: true }));
  await prompts.offer({ ...invite, nick: "eve2" });
  expect(prompts.forEnd("c-1").at(-1)).toMatchObject({ state: "done", text: "eve2 is already in #dev-test." });
  respond(() => Response.json({ error: "person not found" }, { status: 404 }));
  await prompts.offer({ ...invite, nick: "ghost" });
  expect(prompts.forEnd("c-1").at(-1)).toMatchObject({ state: "done", text: "Couldn't find @ghost." });
  await prompts.offer({ ...invite, nick: "eve" });
  expect(prompts.forEnd("c-1").at(-1)).toMatchObject({ state: "done", text: "You're already in #dev-test." });
}));

test("Add calls the members route with the message id and shows the outcome", () => withFetch(async (calls, respond) => {
  const { prompts, focused } = setup();
  respond(() => Response.json({ channel: "#dev-open", nick: "poll", kind: "bot", member: false }));
  await prompts.offer({ ...mention, nick: "poll" });
  const prompt = prompts.forMessage("m-1")[0]!;
  let release!: (response: Response) => void;
  respond(() => new Promise<Response>((resolve) => { release = resolve; }));
  const adding = prompts.add(prompt);
  expect(prompt.state).toBe("busy");
  expect(prompts.canAdd(prompt)).toBe(false);
  prompts.ignore(prompt);
  expect(prompts.items).toHaveLength(1);
  release(Response.json({ channel: "#dev-open", nick: "poll", added: true }));
  await adding;
  expect(calls.at(-1)).toEqual({ path: "/api/channels/%23dev-open/members", method: "POST", body: { nick: "poll", msgid: "msg-1" } });
  expect(prompt).toMatchObject({ state: "done", text: "Added @poll." });
  expect(focused()).toBe(1);
  await prompts.add(prompt);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
}));

test("Add waits until the server has confirmed the message", () => withFetch(async (calls, respond) => {
  const { prompts, serverIds } = setup({});
  respond(() => Response.json({ channel: "#dev-open", nick: "poll", kind: "bot", member: false }));
  await prompts.offer({ ...mention, nick: "poll" });
  const prompt = prompts.forMessage("m-1")[0]!;
  expect(prompts.canAdd(prompt)).toBe(false);
  await prompts.add(prompt);
  expect(calls.some((call) => call.method === "POST")).toBe(false);
  serverIds["m-1"] = "msg-9";
  expect(prompts.canAdd(prompt)).toBe(true);
}));

test("/invite Add sends no message id and shows the server's error", () => withFetch(async (calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ channel: "#dev-test", nick: "ada", kind: "human", member: false }));
  await prompts.offer({ ...invite, nick: "ada" });
  const prompt = prompts.forEnd("c-1")[0]!;
  respond(() => Response.json({ error: "could not add to channel" }, { status: 502 }));
  await prompts.add(prompt);
  expect(calls.at(-1)!.body).toEqual({ nick: "ada" });
  expect(prompt).toMatchObject({ state: "done", text: "Could not add to channel." });
}));

test("Ignore dismisses the prompt", () => withFetch(async (_calls, respond) => {
  const { prompts, focused } = setup();
  respond(() => Response.json({ channel: "#dev-open", nick: "poll", kind: "bot", member: false }));
  await prompts.offer({ ...mention, nick: "poll" });
  prompts.ignore(prompts.forMessage("m-1")[0]!);
  expect(prompts.items).toEqual([]);
  expect(focused()).toBe(1);
}));

test("people who cannot add members get a note without Add", () => withFetch(async (calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ error: "channel membership required" }, { status: 403 }));
  await prompts.offer({ ...mention, nick: "poll" });
  expect(prompts.forMessage("m-1")).toMatchObject([{ state: "done", text: "@poll isn't in #dev-open. You can't add people here." }]);
  expect(prompts.canAdd(prompts.forMessage("m-1")[0]!)).toBe(false);
  await prompts.offer({ ...mention, messageId: "m-2", place: "dm", nick: "poll" });
  await prompts.offer({ ...mention, messageId: "m-3", place: "thread", nick: "help" });
  expect(prompts.forMessage("m-2")).toMatchObject([{ state: "done", text: "poll can't join DMs." }]);
  expect(prompts.forMessage("m-3")).toMatchObject([{ state: "done", text: "help can't join threads." }]);
  expect(calls).toHaveLength(1);
}));

test("a helper note in a group names the group, or says this group without a name", () => withFetch(async (_calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ channel: "#g-1", nick: "poll", kind: "bot", member: false }));
  await prompts.offer({ ...mention, channel: "#g-1", place: "group", title: "Lunch crew", nick: "poll" });
  await prompts.offer({ ...mention, channel: "#g-1", place: "group", messageId: "m-2", nick: "poll" });
  expect(prompts.forMessage("m-1")).toMatchObject([{ state: "ask", text: "@poll isn't in Lunch crew." }]);
  expect(prompts.forMessage("m-2")).toMatchObject([{ state: "ask", text: "@poll isn't in this group." }]);
  expect(prompts.label(prompts.forMessage("m-1")[0]!)).toBe("Add");
}));

test("finds mentioned people, leaving out helpers, bots and addresses", () => {
  expect(mentionedPeople("@ada and @Bob-2, @ada again. Also @poll, @remind, @welcome, mail@eve.test")).toEqual(["ada", "Bob-2"]);
});

test("a person mentioned outside the channel gets Add under that message", () => withFetch(async (calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ channel: "#dev-open", nick: "Ada", kind: "human", member: false }));
  await prompts.offer({ ...mention, nick: "ada", person: true });
  expect(calls).toEqual([{ path: "/api/channels/%23dev-open/members/ada", method: "GET", body: null }]);
  const [prompt] = prompts.forMessage("m-1");
  expect(prompt).toMatchObject({ nick: "Ada", state: "ask", text: "@Ada isn't in #dev-open." });
  expect(prompts.label(prompt!)).toBe("Add");
  expect(prompts.segments(prompt!)).toEqual([{ nick: "Ada" }, { text: " isn't in #dev-open." }]);
  respond(() => Response.json({ channel: "#dev-open", nick: "Ada", added: true }));
  await prompts.add(prompt!);
  expect(calls.at(-1)).toEqual({ path: "/api/channels/%23dev-open/members", method: "POST", body: { nick: "Ada", msgid: "msg-1" } });
  expect(prompt).toMatchObject({ state: "done", text: "Added @Ada." });
}));

test("a person mention stays quiet for members, bots, other people's agents, unknown nicks and yourself", () => withFetch(async (calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ channel: "#dev-open", nick: "ada", kind: "human", member: true }));
  await prompts.offer({ ...mention, nick: "ada", person: true });
  respond(() => Response.json({ channel: "#dev-open", nick: "welcome", kind: "bot", member: false }));
  await prompts.offer({ ...mention, nick: "welcome", person: true });
  // The lookup answers 404 for an agent someone else owns.
  respond(() => Response.json({ error: "person not found" }, { status: 404 }));
  await prompts.offer({ ...mention, nick: "ada-agent", person: true });
  await prompts.offer({ ...mention, nick: "ghost", person: true });
  await prompts.offer({ ...mention, nick: "eve", person: true });
  expect(prompts.items).toEqual([]);
  expect(calls).toHaveLength(4);
}));

// Regression: "@pi-d6a3 ping" in a channel the agent isn't in reached nobody and said nothing.
test("your agent mentioned in an invite-only channel it isn't in gets Invite under that message", () => withFetch(async (calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ channel: "#ops", nick: "pi-d6a3", kind: "agent", member: false }));
  await prompts.offer({ ...mention, channel: "#ops", nick: "pi-d6a3", person: true });
  const [prompt] = prompts.forMessage("m-1");
  expect(prompt).toMatchObject({ nick: "pi-d6a3", agent: true, state: "ask", text: "pi-d6a3 isn't in this channel yet. This agent can read the channel's full history." });
  expect(prompts.label(prompt!)).toBe("Invite");
  expect(prompts.segments(prompt!)).toEqual([{ nick: "pi-d6a3" }, { text: " isn't in this channel yet. This agent can read the channel's full history." }]);
  respond(() => Response.json({ channel: "#ops", nick: "pi-d6a3", added: true }));
  await prompts.add(prompt!);
  expect(calls.at(-1)).toEqual({ path: "/api/channels/%23ops/members", method: "POST", body: { nick: "pi-d6a3" } });
  expect(prompt).toMatchObject({ state: "done", text: "Added @pi-d6a3. Mention it again to ask." });
  respond(() => Response.json({ channel: "#ops", nick: "pi-d6a3", kind: "agent", member: true }));
  await prompts.offer({ ...mention, channel: "#ops", messageId: "m-2", nick: "pi-d6a3", person: true });
  expect(prompts.forMessage("m-2")).toEqual([]);
}));

test("your agent mentioned in an open channel gets a note without Invite", () => withFetch(async (_calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ error: "agents can only join secret channels" }, { status: 403 }));
  await prompts.offer({ ...mention, nick: "pi-d6a3", person: true });
  const [prompt] = prompts.forMessage("m-1");
  expect(prompt).toMatchObject({ nick: "pi-d6a3", agent: true, state: "done", text: "pi-d6a3 only answers in its DM or in invite-only channels." });
  expect(prompts.canAdd(prompt!)).toBe(false);
}));

test("/invite with an email offers Invite by email and shows the sent invitation", () => withFetch(async (calls, respond) => {
  const { prompts, focused } = setup();
  respond(() => Response.json({ remaining: 4, limit: 5 }));
  await prompts.offerEmail({ conversationId: "c-1", channel: "#dev-test", email: "kim@example.test" });
  expect(calls).toEqual([{ path: "/api/invites/email", method: "GET", body: null }]);
  const [prompt] = prompts.forEnd("c-1");
  expect(prompt).toMatchObject({ email: "kim@example.test", state: "ask", text: "Send kim@example.test an invitation to #dev-test?" });
  expect(prompts.label(prompt!)).toBe("Invite by email");
  expect(prompts.segments(prompt!)).toEqual([{ text: "Send kim@example.test an invitation to #dev-test?" }]);
  respond(() => Response.json({ conversation: { type: "channel", channel: "#dev-test" }, recipients: [{ email: "kim@example.test", status: "invited" }], remaining: 3, limit: 5 }));
  await prompts.add(prompt!);
  expect(calls.at(-1)).toEqual({ path: "/api/conversations", method: "POST", body: { recipients: [{ email: "kim@example.test" }], destination: { type: "channel", channel: "#dev-test" } } });
  expect(prompt).toMatchObject({ state: "done", text: "Invitation sent to kim@example.test." });
  expect(focused()).toBe(1);
}));

test("an email invite reports an existing account, a failure, and no invites left", () => withFetch(async (_calls, respond) => {
  const { prompts } = setup();
  respond(() => Response.json({ remaining: 1, limit: 5 }));
  await prompts.offerEmail({ conversationId: "c-1", channel: "#dev-test", email: "ada@example.test" });
  const prompt = prompts.forEnd("c-1")[0]!;
  respond(() => Response.json({ conversation: { type: "channel", channel: "#dev-test" }, recipients: [{ accountId: "a-2", nick: "ada", status: "added" }] }));
  await prompts.add(prompt);
  expect(prompt.text).toBe("Added @ada.");
  respond(() => Response.json({ remaining: 1, limit: 5 }));
  await prompts.offerEmail({ conversationId: "c-1", channel: "#dev-test", email: "bo@example.test" });
  const failed = prompts.forEnd("c-1").at(-1)!;
  respond(() => Response.json({ error: "You have used all 5 email invites." }, { status: 403 }));
  await prompts.add(failed);
  expect(failed).toMatchObject({ state: "done", text: "You have used all 5 email invites." });
  respond(() => Response.json({ remaining: 0, limit: 5 }));
  await prompts.offerEmail({ conversationId: "c-1", channel: "#dev-test", email: "cy@example.test" });
  expect(prompts.forEnd("c-1").at(-1)).toMatchObject({ state: "done", text: "You have used all 5 email invites." });
  respond(() => Response.json({ error: "verified account required" }, { status: 403 }));
  await prompts.offerEmail({ conversationId: "c-1", channel: "#dev-test", email: "di@example.test" });
  expect(prompts.forEnd("c-1").at(-1)).toMatchObject({ state: "done", text: "Verify your email before you invite di@example.test." });
}));

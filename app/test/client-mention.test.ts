// Mention token and candidate rules for the composer `@` picker. One file per process.
import { expect, test } from "bun:test";

const { mentionToken, mentionCandidates } = await import("../client/mentions.ts");

test("mentionToken finds the trailing @token only", () => {
  expect(mentionToken("hi @ev")).toEqual({ query: "ev", start: 3 });
  expect(mentionToken("@ev")).toEqual({ query: "ev", start: 0 });
  expect(mentionToken("email me@ev")).toBeNull();
  expect(mentionToken("done @ev ")).toBeNull();
  expect(mentionToken("no at here")).toBeNull();
});

test("mentionToken reads the token ending at the caret, not the end of the draft", () => {
  const text = "hi @cla see you";
  expect(mentionToken(text, 7)).toEqual({ query: "cla", start: 3 });
  expect(mentionToken(text, 4)).toEqual({ query: "", start: 3 });
  expect(mentionToken("@cla existing", 4)).toEqual({ query: "cla", start: 0 });
  expect(mentionToken(text, 2)).toBeNull();
  expect(mentionToken(text, 99)).toBeNull();
});

test("the mention picker opens for an @token before existing text", async () => {
  (globalThis as any).window ??= new EventTarget();
  const { mentionPickerComponent } = await import("../client/composer-pickers.ts");
  const component = mentionPickerComponent() as any;
  Object.assign(component, { composer: "@ad see you", emoji: { caret: 3 }, account: "me", roomMembers: ["ada", "bob"], roomMembersPublic: false, contacts: [], directs: [], messages: [], agentProfiles: {} });
  expect(component.matches()).toEqual(["ada"]);
  component.emoji.caret = 11;
  expect(component.matches()).toEqual([]);
});

test.each([
  ["puts room members before contacts and dedupes", "", ["bob", "ada"], ["ada", "carol"], ["bob", "ada", "carol"]],
  ["filters by folded prefix", "EV", ["adam", "Eve", "steve"], [], ["Eve"]],
  ["caps at eight", "", Array.from({ length: 12 }, (_, i) => `user${i}`), [], Array.from({ length: 8 }, (_, i) => `user${i}`)],
])("mentionCandidates %s", (_name, query, members, contacts, expected) => {
  expect(mentionCandidates(query, members, contacts)).toEqual(expected);
});

// The `@` picker in a channel: agents only while attached and known (a removed one is forgotten),
// under their current name; people as before. Shapes mirror the runtime's root scope.
test("the mention picker offers only active agents, under their current name", async () => {
  (globalThis as any).window ??= new EventTarget();
  const { mentionPickerComponent } = await import("../client/composer-pickers.ts");
  const attached: Record<string, boolean> = { "pi-d6a3": true, "pi-0ff1": false };
  const component = mentionPickerComponent() as any;
  Object.assign(component, {
    composer: "hi @", account: "bitbonsai",
    roomMembers: ["ada", "pi-d6a3", "pi-0ff1"], roomMembersPublic: false,
    contacts: ["carol"], directs: [],
    // pi-241e was removed: its lines are still in history, but its profile is gone.
    messages: [{ authorNick: "pi-241e" }, { authorNick: "ada" }],
    agentProfiles: {
      "pi-d6a3": { nick: "pi-d6a3", owner: "bitbonsai", harness: "pi", name: "slirc.app", repo: "", model: "" },
      "pi-0ff1": { nick: "pi-0ff1", owner: "bitbonsai", harness: "pi", name: "", repo: "", model: "" },
    },
    agentAttached: (nick: string) => attached[nick] === true,
  });
  expect(component.matches()).toEqual(["ada", "pi-d6a3", "carol"]);
  expect(component.label("pi-d6a3")).toBe("slirc.app");
  expect(component.label("ada")).toBe("ada");
  component.composer = "hi @pi";
  expect(component.matches()).toEqual(["pi-d6a3"]);
  // It comes back once it attaches again.
  attached["pi-0ff1"] = true;
  expect(component.matches()).toEqual(["pi-d6a3", "pi-0ff1"]);
  // An open channel has no roster, so people who spoke there still count.
  Object.assign(component, { composer: "hi @", roomMembers: [], roomMembersPublic: true, messages: [{ authorNick: "eve" }] });
  expect(component.matches()).toEqual(["eve", "pi-d6a3", "pi-0ff1", "carol"]);
});

test("mentionCandidates matches a display name as well as the nick", () => {
  const names: Record<string, string> = { "claude-bcdb": "bit", "pi-0ff1": "Docs Bot" };
  const nameOf = (nick: string) => names[nick] ?? "";
  const all = () => true;
  expect(mentionCandidates("b", ["borisb", "claude-bcdb", "ada"], [], all, nameOf)).toEqual(["borisb", "claude-bcdb"]);
  expect(mentionCandidates("BI", ["claude-bcdb"], [], all, nameOf)).toEqual(["claude-bcdb"]);
  expect(mentionCandidates("claude", ["claude-bcdb"], [], all, nameOf)).toEqual(["claude-bcdb"]);
  expect(mentionCandidates("docs", ["pi-0ff1"], [], all, nameOf)).toEqual(["pi-0ff1"]);
  // Prefix only: a name that merely contains the text does not match.
  expect(mentionCandidates("it", ["claude-bcdb"], [], all, nameOf)).toEqual([]);
  // Order stays members then contacts, and the pick is still the nick.
  expect(mentionCandidates("b", ["borisb"], ["claude-bcdb", "bob"], all, nameOf)).toEqual(["borisb", "claude-bcdb", "bob"]);
});

test("the mention picker finds an agent by display name", async () => {
  (globalThis as any).window ??= new EventTarget();
  const { mentionPickerComponent } = await import("../client/composer-pickers.ts");
  const component = mentionPickerComponent() as any;
  Object.assign(component, {
    composer: "ping @b", account: "me", roomMembers: ["borisb", "claude-bcdb"], roomMembersPublic: false, contacts: [], directs: [], messages: [],
    agentProfiles: { "claude-bcdb": { nick: "claude-bcdb", owner: "me", harness: "claude", name: "bit", repo: "", model: "" } },
    agentAttached: () => true,
  });
  expect(component.matches()).toEqual(["borisb", "claude-bcdb"]);
});

test("mentionCandidates drops nicks keep rejects without affecting the rest", () => {
  expect(mentionCandidates("", ["ada", "pi-0ff1", "bob"], ["carol"], (nick) => nick !== "pi-0ff1")).toEqual(["ada", "bob", "carol"]);
});

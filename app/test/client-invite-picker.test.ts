// People autocomplete for `/invite ev` and `/invite @ev`: when the picker takes over, where its list
// comes from (people search, never the mention sources), filtering, stale answers, and the pick.
import { expect, test } from "bun:test";
import { inviteCandidates, inviteToken, mentionToken } from "@client/mentions.ts";
import { INVITE_SEARCH_DELAY_MS, mentionPickerComponent } from "@client/composer-pickers.ts";

(globalThis as any).window ??= new EventTarget();
const settle = () => new Promise((resolve) => setTimeout(resolve, INVITE_SEARCH_DELAY_MS + 30));

async function withPeople(answer: (query: string) => string[] | Promise<string[]>, run: (queries: string[]) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const queries: string[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (path: string, init?: RequestInit) => {
      const query = new URL(path, "https://slirc.test").searchParams.get("q") ?? "";
      queries.push(query);
      const nicks = await answer(query);
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return Response.json({ people: nicks.map((nick) => ({ accountId: `${nick}-id`, nick, displayName: nick, avatarUrl: "" })) });
    },
  });
  try { await run(queries); }
  finally { if (saved) Object.defineProperty(globalThis, "fetch", saved); else Reflect.deleteProperty(globalThis, "fetch"); }
}

function picker(composer: string) {
  const component = mentionPickerComponent() as any;
  Object.assign(component, {
    composer, account: "bitbonsai", roomMembers: ["ada"], contacts: ["carol"], directs: [], messages: [],
    $nextTick: (callback: () => void) => callback(),
  });
  return component;
}

test("only /invite plus a partial nick switches the picker to people search", () => {
  expect(inviteToken("/invite @ev")).toBe("ev");
  expect(inviteToken("/invite ev")).toBe("ev");
  expect(inviteToken("/invite ")).toBe("");
  expect(inviteToken("/invite friend@example.com")).toBeNull();
  expect(inviteToken("/invite friend@")).toBeNull();
  expect(inviteToken("/invite @eve hello")).toBeNull();
  expect(inviteToken("/invite @eve ")).toBeNull();
  expect(inviteToken("hi @ev")).toBeNull();
  // Ordinary mentions keep their own token.
  expect(mentionToken("hi @ev")).toEqual({ query: "ev", start: 3 });
});

test("candidates keep search order and drop me and known members", () => {
  expect(inviteCandidates(["eve", "Ada", "bitbonsai", "evan"], ["bitbonsai", "ada"])).toEqual(["eve", "evan"]);
  expect(inviteCandidates(Array.from({ length: 12 }, (_, i) => `p${i}`), [])).toHaveLength(8);
});

test("the list comes from people search, not room members or contacts", () => withPeople(() => ["eve", "ada", "steve"], async (queries) => {
  const component = picker("/invite @ev");
  component.sync();
  expect(component.matches()).toEqual([]);
  await settle();
  expect(queries).toEqual(["ev"]);
  expect(component.matches()).toEqual(["eve", "steve"]);
}));

test("typing on narrows the old list at once and replaces it with the newest answer only", () => withPeople(async (query) => {
  if (query === "e") await new Promise((resolve) => setTimeout(resolve, 80));
  return query === "e" ? ["eve", "ben"] : ["eve"];
}, async (queries) => {
  const component = picker("/invite e");
  component.sync();
  await new Promise((resolve) => setTimeout(resolve, INVITE_SEARCH_DELAY_MS + 10));
  component.composer = "/invite ev";
  component.sync();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(queries).toEqual(["e", "ev"]);
  expect(component.inviteFor).toBe("ev");
  expect(component.matches()).toEqual(["eve"]);
  component.inviteResults = ["eve", "ben"]; component.inviteFor = "e";
  component.composer = "/invite eve";
  expect(component.matches()).toEqual(["eve"]);
}));

test("emails, finished nicks and Escape never search", () => withPeople(() => ["eve"], async (queries) => {
  const component = picker("/invite friend@example.com");
  component.sync();
  component.composer = "/invite @eve ";
  component.sync();
  component.composer = "/invite ev";
  component.dismiss();
  component.sync();
  await settle();
  expect(queries).toEqual([]);
  expect(component.matches()).toEqual([]);
}));

test("picking dispatches the nick; the runtime fills in /invite @nick", async () => {
  const component = picker("/invite ev");
  component.inviteResults = ["eve"]; component.inviteFor = "ev";
  const picked: unknown[] = [];
  const listener = (event: Event) => picked.push((event as CustomEvent).detail);
  window.addEventListener("slirc:mention-pick", listener);
  component.choose();
  window.removeEventListener("slirc:mention-pick", listener);
  expect(picked).toEqual([{ nick: "eve" }]);
  const runtime = await Bun.file(new URL("../client/runtime.ts", import.meta.url)).text();
  expect(runtime).toContain("if (inviteToken(text) !== null) { replaceComposerText(`/invite @${nick} `); return; }");
});

test("a dismissed list comes back for the next token, not for the one that was dismissed", () => withPeople(() => ["eve"], async (queries) => {
  const component = picker("/invite ev");
  component.dismiss();
  component.sync();
  component.composer = "/invite eve";
  component.sync();
  await settle();
  expect(queries).toEqual([]);
  // Another popup (the slash list) can dismiss this one; clearing the token brings it back.
  component.composer = "/invite";
  component.sync();
  expect(component.dismissed).toBe(false);
  component.composer = "/invite @ev";
  component.sync();
  await settle();
  expect(queries).toEqual(["ev"]);
  expect(component.matches()).toEqual(["eve"]);
}));

test("erasing the partial nick after Escape opens the list again for the next one", () => withPeople(() => ["tomas"], async (queries) => {
  const component = picker("/invite @da");
  component.dismiss();
  component.composer = "/invite ";
  component.sync();
  expect(component.dismissed).toBe(false);
  component.composer = "/invite to";
  component.sync();
  await settle();
  expect(queries).toEqual(["to"]);
  expect(component.matches()).toEqual(["tomas"]);
}));

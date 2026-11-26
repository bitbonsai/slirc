// The browser's workspace list: carried between origins in the fragment, merged, and filtered.
import { expect, test } from "bun:test";
import { MAX_WORKSPACES, WORKSPACE_LIST_KEY, decodeWorkspaces, encodeWorkspaces, forgetWorkspace, mergeWorkspaces, readWorkspaceList, savedWorkspaces, takeCarriedWorkspaces, workspaceLink } from "../client/workspace-list.ts";

const NOW = 1_763_900_000_000;
const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map }; };
const page = (origin: string, hash = "", pathname = "/") => ({ origin, hash, pathname, search: "" });
const hist = () => { const urls: string[] = []; return { state: null, replaceState: (_d: unknown, _u: string, url?: string | URL | null) => { urls.push(String(url)); }, urls }; };

test("encode and decode round-trip, newest first", () => {
  const text = encodeWorkspaces({ "https://xmiro.slirc.app": NOW - 10, "https://calango.slirc.app": NOW - 5 });
  expect(text).toBe(`calango.slirc.app:${NOW - 5},xmiro.slirc.app:${NOW - 10}`);
  expect(decodeWorkspaces(text, NOW)).toEqual({ "https://calango.slirc.app": NOW - 5, "https://xmiro.slirc.app": NOW - 10 });
});

test("only addresses the dialog accepts get in", () => {
  const text = ["evil.example.com:1", "http://x.slirc.app:1", "a.slirc.app:8443:1", "user@x.slirc.app:1", "bare:1", "ok.slirc.app:abc", "ok.slirc.app:2", "-bad.slirc.app:1"].join(",");
  expect(decodeWorkspaces(text, NOW)).toEqual({ "https://evil.example.com": 1, "https://ok.slirc.app": 2 });
});

test("future times are clamped and the size is capped", () => {
  expect(decodeWorkspaces(`a.slirc.app:${NOW * 10}`, NOW)).toEqual({ "https://a.slirc.app": NOW });
  const many = Array.from({ length: 40 }, (_, i) => `w${i}.slirc.app:${i + 1}`).join(",");
  expect(Object.keys(decodeWorkspaces(many, NOW))).toHaveLength(MAX_WORKSPACES);
  expect(decodeWorkspaces("a.slirc.app:1,".repeat(300), NOW)).toEqual({});
});

test("merge is a union by origin that keeps the latest use, and removals here stay removed", () => {
  const list = { saved: { "https://a.slirc.app": 5, "https://b.slirc.app": 9 }, removed: { "https://c.slirc.app": 3 } };
  const merged = mergeWorkspaces(list, { "https://a.slirc.app": 7, "https://b.slirc.app": 1, "https://c.slirc.app": 8, "https://d.slirc.app": 2 });
  expect(merged.saved).toEqual({ "https://a.slirc.app": 7, "https://b.slirc.app": 9, "https://d.slirc.app": 2 });
  expect(merged.removed).toEqual({ "https://c.slirc.app": 3 });
});

test("a carried list can't plant a foreign host, but keeps one this browser already saved", () => {
  const list = { saved: { "https://chat.example.org": 4 }, removed: {} };
  const merged = mergeWorkspaces(list, { "https://slirc-login.example": 9, "https://chat.example.org": 6, "https://app.slirc.org": 5, "https://xmiro.slirc.app": 3, "https://slirc.app.evil.com": 2 });
  expect(merged.saved).toEqual({ "https://chat.example.org": 6, "https://app.slirc.org": 5, "https://xmiro.slirc.app": 3 });
  const store = memory();
  takeCarriedWorkspaces(page("https://calango.slirc.app", `#workspaces=slirc-login.example:${NOW - 1},a.slirc.app:${NOW - 2}`), hist(), store, NOW);
  expect(savedWorkspaces("https://calango.slirc.app", store, NOW)).toEqual(["https://a.slirc.app"]);
  // A self-hosted origin does not accept hosted origins carried in a fragment either.
  const selfHosted = memory();
  takeCarriedWorkspaces(page("https://chat.example.org", `#workspaces=a.slirc.app:${NOW - 1},app.slirc.org:${NOW - 2}`), hist(), selfHosted, NOW);
  expect(savedWorkspaces("https://chat.example.org", selfHosted, NOW)).toEqual([]);
});

test("switching carries the list to the other origin, which merges it and strips the fragment", () => {
  const calango = memory(), xmiro = memory();
  takeCarriedWorkspaces(page("https://calango.slirc.app"), hist(), calango, NOW - 1000);
  // ai-guild was saved on calango earlier.
  calango.setItem(WORKSPACE_LIST_KEY, JSON.stringify({ saved: { ...JSON.parse(calango.getItem(WORKSPACE_LIST_KEY)!).saved, "https://ai-guild.slirc.app": NOW - 5000 }, removed: {} }));
  const link = workspaceLink("https://xmiro.slirc.app", "https://calango.slirc.app", calango, NOW);
  expect(link).toBe(`https://xmiro.slirc.app/#workspaces=calango.slirc.app:${NOW},ai-guild.slirc.app:${NOW - 5000}`);
  expect(link).not.toContain("?");
  const h = hist();
  takeCarriedWorkspaces(page("https://xmiro.slirc.app", link.slice(link.indexOf("#"))), h, xmiro, NOW + 10);
  expect(h.urls).toEqual(["/"]);
  expect(savedWorkspaces("https://xmiro.slirc.app", xmiro, NOW + 10)).toEqual(["https://calango.slirc.app", "https://ai-guild.slirc.app"]);
  // And back: calango knows xmiro too.
  expect(savedWorkspaces("https://calango.slirc.app", calango, NOW + 20)).toEqual(["https://xmiro.slirc.app", "https://ai-guild.slirc.app"]);
});

test("a load without the fragment leaves the address alone", () => {
  const h = hist(), store = memory();
  takeCarriedWorkspaces(page("https://calango.slirc.app", "#/rooms"), h, store, NOW);
  expect(h.urls).toEqual([]);
  expect(readWorkspaceList(store, NOW).saved).toEqual({ "https://calango.slirc.app": NOW });
});

test("a dev origin on a port or http is never saved", () => {
  const store = memory();
  takeCarriedWorkspaces(page("http://localhost:8080"), hist(), store, NOW);
  expect(readWorkspaceList(store, NOW).saved).toEqual({});
  expect(workspaceLink("https://a.slirc.app", "http://localhost:8080", store, NOW)).toBe("https://a.slirc.app/");
});

test("a removed workspace stays off this origin until opened from here again", () => {
  const store = memory();
  workspaceLink("https://a.slirc.app", "https://calango.slirc.app", store, NOW - 100);
  forgetWorkspace("https://a.slirc.app", store, NOW - 50);
  takeCarriedWorkspaces(page("https://calango.slirc.app", `#workspaces=a.slirc.app:${NOW - 10}`), hist(), store, NOW);
  expect(savedWorkspaces("https://calango.slirc.app", store, NOW)).toEqual([]);
  workspaceLink("https://a.slirc.app", "https://calango.slirc.app", store, NOW + 1);
  expect(savedWorkspaces("https://calango.slirc.app", store, NOW + 1)).toEqual(["https://a.slirc.app"]);
});

test("a broken or tampered stored list is cleaned on read", () => {
  const store = memory();
  store.setItem(WORKSPACE_LIST_KEY, "{not json");
  expect(readWorkspaceList(store, NOW)).toEqual({ saved: {}, removed: {} });
  store.setItem(WORKSPACE_LIST_KEY, JSON.stringify({ saved: { "javascript:alert(1)": 1, "https://ok.slirc.app": 2, "https://x.slirc.app/path": 3 } }));
  expect(readWorkspaceList(store, NOW).saved).toEqual({ "https://ok.slirc.app": 2 });
});

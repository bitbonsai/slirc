// After a reload, the links bot's daily summaries painted as bare text and then grew one preview
// card at a time, moving the transcript. Cards already seen are now kept per account and painted
// with the rows. A link that had no card is never stored, so it never reserves an empty box.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const { cachedEmbeds, rememberEmbed, EMBED_CACHE_LIMIT, EMBED_CACHE_MAX_AGE } = await import("../client/embed-cache.ts");

function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

const card = { title: "TanStack Oracles", description: "Oracle-based testing", image: "https://img.test/a.png", site: "GitHub" };

test("a fetched card is read back for the same account and no other", () => {
  const store = memory();
  rememberEmbed("acct-a", "https://github.com/tanstack/oracles", card, store, 1000);
  expect(cachedEmbeds("acct-a", store, 2000)).toEqual({ "https://github.com/tanstack/oracles": card });
  expect(cachedEmbeds("acct-b", store, 2000)).toEqual({});
});

test("old cards expire so a changed page is fetched again", () => {
  const store = memory();
  rememberEmbed("acct", "https://a.test/", card, store, 0);
  expect(Object.keys(cachedEmbeds("acct", store, EMBED_CACHE_MAX_AGE - 1))).toEqual(["https://a.test/"]);
  expect(cachedEmbeds("acct", store, EMBED_CACHE_MAX_AGE)).toEqual({});
});

test("the cache keeps the newest cards up to its limit", () => {
  const store = memory();
  for (let i = 0; i <= EMBED_CACHE_LIMIT; i++) rememberEmbed("acct", `https://a.test/${i}`, card, store, 1000 + i);
  const urls = Object.keys(cachedEmbeds("acct", store, 5000));
  expect(urls.length).toBe(EMBED_CACHE_LIMIT);
  expect(urls).not.toContain("https://a.test/0");
  expect(urls).toContain(`https://a.test/${EMBED_CACHE_LIMIT}`);
});

test("stored data is checked like a server response", () => {
  const store = memory();
  store.setItem("slirc2-embeds:acct", JSON.stringify({
    "https://ok.test/": { meta: card, at: 1 },
    "https://empty.test/": { meta: {}, at: 1 },
    "https://evil.test/": { meta: { player: { src: "https://evil.test/frame" } }, at: 1 },
    "javascript:alert(1)": { meta: card, at: 1 },
  }));
  expect(Object.keys(cachedEmbeds("acct", store, 2))).toEqual(["https://ok.test/"]);
  store.setItem("slirc2-embeds:acct", "not json");
  expect(cachedEmbeds("acct", store, 2)).toEqual({});
});

test("blocked storage leaves the cache empty without throwing", () => {
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(cachedEmbeds("acct", blocked, 1)).toEqual({});
  expect(() => rememberEmbed("acct", "https://a.test/", card, blocked, 1)).not.toThrow();
});

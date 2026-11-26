import { expect, test } from "bun:test";
import { cacheHashOf, rewriteVersions } from "../scripts/version-assets.ts";

// rewriteVersions and cacheHashOf are the two pure pieces of scripts/version-assets.ts: the file
// I/O around them (reading public/, writing index.html/legacy.html/app.js/store.js/sw.js) is
// exercised by actually running the script, not unit-tested here.

test("rewriteVersions replaces an existing ?v= with the given hash, on every occurrence", () => {
  const hashByPath = new Map([["/app.js", "abc12345"]]);
  const text = '<script src="/app.js?v=423"></script>\nimport x from "/app.js?v=423";';
  const out = rewriteVersions(text, hashByPath);
  expect(out).toBe('<script src="/app.js?v=abc12345"></script>\nimport x from "/app.js?v=abc12345";');
});

test("rewriteVersions leaves a path with no ?v= alone", () => {
  const hashByPath = new Map([["/manifest.webmanifest", "deadbeef"]]);
  const text = '<link rel="manifest" href="/manifest.webmanifest" />';
  expect(rewriteVersions(text, hashByPath)).toBe(text);
});

test("rewriteVersions only touches the path it was given a hash for", () => {
  const hashByPath = new Map([["/style.css", "aaaaaaaa"]]);
  const text = '<link href="/style.css?v=1" /><script src="/app.js?v=1"></script>';
  expect(rewriteVersions(text, hashByPath)).toBe('<link href="/style.css?v=aaaaaaaa" /><script src="/app.js?v=1"></script>');
});

test("cacheHashOf is stable for the same asset set and order-independent", () => {
  const a = cacheHashOf(new Map([["/app.js", "111"], ["/style.css", "222"]]));
  const b = cacheHashOf(new Map([["/style.css", "222"], ["/app.js", "111"]]));
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{8}$/);
});

test("cacheHashOf changes when any single asset's hash changes", () => {
  const before = cacheHashOf(new Map([["/app.js", "111"], ["/style.css", "222"]]));
  const after = cacheHashOf(new Map([["/app.js", "111"], ["/style.css", "223"]]));
  expect(after).not.toBe(before);
});

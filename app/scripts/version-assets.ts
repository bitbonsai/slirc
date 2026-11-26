// Replaces hand-bumped ?v= cache-busting query strings with short content hashes computed from
// each asset's own bytes, so a forgotten manual bump can no longer leave a stale asset behind a
// fresh index.html. Run via `bun run version` after touching any asset in the SHELL (client bundle inputs,
// style.css, vendor files, icons); commit the
// result. See AGENTS.md's sw.js cache-bump gotcha.
import { createHash } from "node:crypto";

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const HASH_LEN = 8;
// Same filter sw.js's shellUrls() uses at install time, so "what gets hashed" and "what gets
// cached" never drift apart.
const ASSET_RE = /\.(css|js|png|svg|webmanifest)(\?|$)/;
// The shell carries versioned static assets. The TypeScript bundle has its own /api/version hash.
const TARGETS = ["index.html", "sw.js"];

// Every asset worth hashing: anything index.html links with a hashable extension (some, like the
// favicons, have no ?v= yet and are only fed into the CACHE digest below), plus every path that
// already carries a ?v= anywhere across the target files, wherever that reference lives.
function assetPaths(html: string, targetTexts: string[]): string[] {
  const fromHtml = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]).filter((u) => ASSET_RE.test(u)).map((u) => u.split("?")[0]);
  const fromVersioned = targetTexts.flatMap((text) => [...text.matchAll(/(\/[^\s"'?]+)\?v=[^"'\s]*/g)].map((m) => m[1]));
  return [...new Set([...fromHtml, ...fromVersioned])];
}

async function hashAsset(path: string): Promise<string | null> {
  const file = Bun.file(new URL(`.${path}`, PUBLIC_DIR));
  if (!(await file.exists())) return null;
  const bytes = await file.arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex").slice(0, HASH_LEN);
}

// Rewrites every `<path>?v=<anything>` occurrence of a hashed asset in `text`. A path referenced
// without a `?v=` today is left alone: nothing here decides to start versioning a new asset.
export function rewriteVersions(text: string, hashByPath: Map<string, string>): string {
  let out = text;
  for (const [path, hash] of hashByPath) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}\\?v=[^"'\\s]*`, "g"), `${path}?v=${hash}`);
  }
  return out;
}

// One hash of the whole hashed-asset set, so any change to any asset produces a new shell
// generation even on the rare edit that doesn't touch index.html's markup.
export function cacheHashOf(hashByPath: Map<string, string>): string {
  const digest = createHash("sha256");
  for (const path of [...hashByPath.keys()].sort()) digest.update(`${path}:${hashByPath.get(path)}`);
  return digest.digest("hex").slice(0, HASH_LEN);
}

async function main() {
  const before = new Map<string, string>();
  for (const name of TARGETS) before.set(name, await Bun.file(new URL(name, PUBLIC_DIR)).text());

  const paths = assetPaths(before.get("index.html")!, [...before.values()]);
  const hashByPath = new Map<string, string>();
  for (const path of paths) {
    const hash = await hashAsset(path);
    if (hash) hashByPath.set(path, hash);
  }

  for (const name of TARGETS) {
    const text = before.get(name)!;
    let after = rewriteVersions(text, hashByPath);
    if (name === "sw.js") {
      const cacheHash = cacheHashOf(hashByPath);
      after = after.replace(/const CACHE = "shell-v[^"]*";/, `const CACHE = "shell-v${cacheHash}";`);
    }
    if (after !== text) await Bun.write(new URL(name, PUBLIC_DIR), after);
  }

  console.log(`version-assets: hashed ${hashByPath.size} assets, CACHE shell-v${cacheHashOf(hashByPath)}`);
}

if (import.meta.main) await main();

import { createHash } from "node:crypto";
import { text } from "./common.ts";
import { devLinks, hash } from "./session.ts";
import { brandKind } from "../config.ts";

// One client bundle, built from source on first request and cached for the process lifetime. A
// deploy restarts the process, so the version hash tracks the served bytes; nothing is checked in.
// In devLinks mode the build runs per request: local edits to client/ are not necessarily Bun
// --watch module dependencies, so a per-process cache would serve stale code until a restart.
let clientBuild: Promise<{ version: string; body: string } | null> | undefined;

// The video encoder (WebCodecs plus Mediabunny's MP4 muxer) is its own minified bundle, loaded only
// when someone picks a video, so the chat client does not carry it.
let videoEncodeBuild: Promise<{ version: string; body: string } | null> | undefined;

// Short content hash of the served client bundle, the candidate's /api/version value.
export function clientVersion(bundle: string): string {
  return createHash("sha256").update(bundle).digest("hex").slice(0, 8);
}

function runClientBuild(entry = "./client/main.ts", minify = false) {
  return Bun.build({ entrypoints: [entry], target: "browser", minify })
    .then(async (build) => {
      if (!build.success || !build.outputs[0]) { console.error("client build failed", build.logs); return null; }
      const body = await build.outputs[0].text();
      return { version: clientVersion(body), body };
    })
    .catch(() => null);
}

export function buildClient() {
  // ponytail: build on request; a checked-in artifact can wait until build cost shows up.
  return devLinks ? runClientBuild() : (clientBuild ??= runClientBuild());
}

export const buildVideoEncode = () => (devLinks ? runClientBuild("./client/video-encode.ts", true) : (videoEncodeBuild ??= runClientBuild("./client/video-encode.ts", true)));

// Every first-party file the shell loads is addressed with a short hash of its own bytes, so its
// address changes exactly when the file does. A browser or a proxy that kept the old file for
// hours then cannot pair it with new HTML: the new HTML asks for a different address.
const assetHashes = new Map<string, string>();

export async function assetVersion(path: string): Promise<string> {
  if (path === "/client.js") return (await buildClient())?.version || "";
  if (path === "/video-encode.js") return (await buildVideoEncode())?.version || "";
  // Local dev edits files under a running process, so nothing is remembered there.
  const known = devLinks ? undefined : assetHashes.get(path);
  if (known !== undefined) return known;
  if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.includes("..")) return "";
  const file = Bun.file(`./public${path}`);
  const hash = (await file.exists()) ? createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex").slice(0, 8) : "";
  assetHashes.set(path, hash);
  return hash;
}

const SHELL_ASSET = /\b(href|src)="(\/[A-Za-z0-9_./-]+\.(?:js|css|webmanifest|svg))(?:\?v=[^"#]*)?(#[^"]*)?"/g;

// Rewrites each script, stylesheet, manifest and SVG reference in a served page to carry the
// hash of the file as it is now. A `?v=` already in the markup is replaced, never trusted.
export async function versionShell(html: string): Promise<string> {
  const paths = [...new Set([...html.matchAll(SHELL_ASSET)].map((match) => match[2]!))];
  const versions = new Map<string, string>();
  for (const path of paths) versions.set(path, await assetVersion(path));
  const versioned = html.replace(SHELL_ASSET, (whole, attribute: string, path: string, fragment = "") => {
    const version = versions.get(path);
    return version ? `${attribute}="${path}?v=${version}${fragment}"` : whole;
  });
  // The client draws icons from the sprite by address; it reads the sprite's version from here.
  const sprite = await assetVersion("/icons/lucide/sprite.svg");
  // The same for the video encoder, which the client imports on demand.
  const video = await assetVersion("/video-encode.js");
  // The wordmark follows the instance; style.css swaps the lockup on data-brand and data-theme.
  const branded = versioned.replace(/<html\b/, `<html data-brand="${brandKind()}"`);
  const metas = (sprite ? `<meta name="slirc-sprite" content="${sprite}" />` : "") + (video ? `<meta name="slirc-video" content="${video}" />` : "");
  return metas ? branded.replace("</head>", `${metas}</head>`) : branded;
}

// A versioned address never changes its bytes, so it may be kept for a year. The same file asked
// for without its current version must be checked with the server every time.
const LONG_CACHE = "public, max-age=31536000, immutable";

export async function assetCacheControl(path: string, version: string | undefined): Promise<string> {
  if (devLinks || !version) return "no-cache";
  return version === (await assetVersion(path)) ? LONG_CACHE : "no-cache";
}

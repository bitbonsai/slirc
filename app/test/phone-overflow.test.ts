import { expect, test } from "bun:test";
import { savedWorkspaceCount, workspaceChoices } from "@client/workspace-mark.ts";

// Phone screens scroll up and down only (25 Nov 2026: Admin dragged sideways and cut text off).
const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
const docsCss = await Bun.file(new URL("../public/docs/docs.css", import.meta.url)).text();
const nav = await Bun.file(new URL("../partials/mobile-navigation.html", import.meta.url)).text();
const plain = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

// Each top-level rule as [selector, body]; nested @media blocks keep their inner text.
function rules(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0, start = 0, open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") { if (depth++ === 0) open = i; }
    else if (text[i] === "}") {
      depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
      if (depth === 0) { out.push([text.slice(start, open).trim(), text.slice(open + 1, i)]); start = i + 1; }
    }
  }
  expect(depth).toBe(0);
  return out;
}

test("style.css has no stray closing brace, so no rule after it gets dropped", () => {
  const all = rules(plain(css));
  // A stray } at the top level eats the next selector: it showed up as "} .channel-intro".
  for (const [selector] of all) expect(selector.startsWith("}")).toBe(false);
  const intro = all.find(([selector]) => selector === ".channel-intro");
  expect(intro?.[1]).toContain("font-family: var(--ui)");
});

test("every phone screen body clips sideways overflow and stops the sideways rubber band", () => {
  const listed = (selector: string) => selector.split(",").map((s) => s.trim());
  const lock = rules(plain(css)).find(([selector]) => listed(selector).includes(".mobile-screen-body") && listed(selector).includes(".mobile-settings-body"));
  expect(lock?.[1]).toContain("overflow-x: clip");
  expect(lock?.[1]).toContain("overscroll-behavior-x: none");
  const phone = rules(plain(css)).find(([selector]) => selector.startsWith("@media (max-width: 640px), (pointer: coarse)"))?.[1] ?? "";
  expect(phone).toMatch(/\.chat, \.reply-thread-stream \{ overflow-x: clip; overscroll-behavior-x: none; \}/);
});

test("a visually hidden input stays 1px wide inside a profile card", () => {
  // .profile-dialog-card input set width: 100% on Admin's hidden file input, 73px past a 390px screen.
  expect(css).toContain(".profile-dialog-card input:not(.sr-only), .profile-dialog-card textarea");
});

test("docs pages on a phone wrap long inline code and clip the page sideways", () => {
  const phone = rules(plain(docsCss)).filter(([selector]) => selector === "@media (max-width: 640px)").map(([, b]) => b).join("");
  expect(phone).toContain("html, body { overflow-x: clip; overscroll-behavior-x: none; }");
  expect(phone).toContain(":not(pre) > code { white-space: normal; overflow-wrap: anywhere; }");
});

test("the More workspace row counts saved workspaces and hides the count for one", () => {
  const row = nav.split('class="mobile-row workspace-row-more"')[1]?.split("</button>")[0] ?? "";
  expect(row).toContain('<span class="workspace-count" x-show="workspaceCount() > 1" x-text="workspaceCount()" aria-hidden="true"></span>');
  expect(row.indexOf("workspace-count")).toBeLessThan(row.indexOf("workspace-row-end"));
  expect(savedWorkspaceCount(workspaceChoices("https://chat.example.com", []))).toBe(1);
  expect(savedWorkspaceCount(workspaceChoices("https://chat.example.com", ["https://two.example.com", "https://three.example.com", "https://two.example.com"]))).toBe(3);
  // A hosted workspace offers app.slirc.org in the dialog; nobody saved it, so it isn't counted.
  const hosted = workspaceChoices("https://team.slirc.app", []);
  expect(hosted.length).toBeGreaterThan(1);
  expect(savedWorkspaceCount(hosted)).toBe(1);
});

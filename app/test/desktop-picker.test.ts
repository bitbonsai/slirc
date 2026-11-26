// The Mac app's own workspace picker (desktop/Slirc/Picker), shown where no signed-in page can
// open the web client's workspace dialog. It draws rows with the dialog's workspace marks and lets
// the app check every address.
import { expect, test } from "bun:test";
import { assets } from "../../desktop/picker-assets.ts";
import { WORKSPACE_PALETTE } from "../client/workspace-mark.ts";

const picker = new URL("../../desktop/Slirc/Picker/", import.meta.url);
await import(new URL("workspace-mark.js", picker).href);
await import(new URL("mac-picker.js", picker).href);
await import(new URL("mac-unreachable.js", picker).href);
const { unreachableKey } = (globalThis as unknown as { slircMacUnreachable: { unreachableKey: (key: string, shift: boolean, at: number, count: number) => Record<string, unknown> | null } }).slircMacUnreachable;
const { pickerRows, label } = (globalThis as unknown as { slircMacPicker: { pickerRows: (w: string[], s: string | null) => Array<Record<string, unknown>>; label: (o: string) => string } }).slircMacPicker;

test("the picker's copies of the web dialog's marks are current", async () => {
  for (const [name, make] of Object.entries(assets)) {
    expect(await Bun.file(new URL(name, picker)).text(), `run bun desktop/picker-assets.ts (${name})`).toBe(await make());
  }
});

test("saved workspaces come first in the order opened, then app.slirc.org until it is saved", () => {
  const rows = pickerRows(["https://ai-guild.slirc.app", "https://dev.example.test:8443"], "https://dev.example.test:8443");
  expect(rows.map((row) => [row.origin, row.saved, row.selected])).toEqual([
    ["https://ai-guild.slirc.app", true, false],
    ["https://dev.example.test:8443", true, true],
    ["https://app.slirc.org", false, false],
  ]);
  expect(rows[0]).toMatchObject({ name: "ai-guild", letter: "A", label: "ai-guild.slirc.app", note: "" });
  expect(WORKSPACE_PALETTE).toContain(rows[0]!.color as string);
  expect(rows[2]).toMatchObject({ name: "Slirc", logo: "/icons/slirc.svg", note: "Slirc's own workspace" });
  expect(pickerRows(["https://app.slirc.org"], null).map((row) => row.origin)).toEqual(["https://app.slirc.org"]);
  expect(pickerRows([], null).map((row) => row.saved)).toEqual([false]);
});

test("a saved address with a port shows in full, any other by its host", () => {
  expect(label("https://dev.example.test:8443")).toBe("https://dev.example.test:8443");
  expect(label("https://xmiro.slirc.app")).toBe("xmiro.slirc.app");
});

test("the page loads only its bundled scripts, marks first", async () => {
  const html = await Bun.file(new URL("picker.html", picker)).text();
  expect(html).toContain("script-src 'self'");
  expect([...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1])).toEqual(["workspace-mark.js", "mac-picker.js"]);
});

test("the picker takes its list keys from the shared workspace code, not its own copy", async () => {
  const script = await Bun.file(new URL("mac-picker.js", picker)).text();
  expect(script).toContain("slircWorkspaceMark.installWorkspaceKeys(");
  expect(script).not.toContain("ArrowDown");
  expect(await Bun.file(new URL("workspace-mark.js", picker)).text()).toContain("function installWorkspaceKeys(");
});

test("every Mac workspace switch goes to the picker page, none to a native alert", async () => {
  const swift = await Bun.file(new URL("../../desktop/Slirc/AppDelegate.swift", import.meta.url)).text();
  expect(swift).not.toContain("chooseWorkspace");
  expect(swift).not.toContain("WorkspaceList");
  expect(swift).not.toContain("Open your workspace");
  expect(swift.match(/showPicker\(canCancel:/g)?.length).toBeGreaterThanOrEqual(6);
});

test("the unreachable screen is a bundled page, not a native alert, and the app handles each button", async () => {
  const swift = await Bun.file(new URL("../../desktop/Slirc/AppDelegate.swift", import.meta.url)).text();
  const unreachable = swift.slice(swift.indexOf("private func unreachable("), swift.indexOf("private func reached("));
  expect(unreachable).not.toContain("NSAlert");
  expect(unreachable).toContain('name: "unreachable"');
  for (const key of ["retry", "switch", "quit"]) expect(unreachable).toContain(`body["${key}"]`);
  expect(unreachable).toContain("webView?.load(URLRequest(url: origin))");
  expect(unreachable).toContain("showPicker(canCancel: false)");
  // Only JavaScript's alert() and confirm() stay native.
  expect(swift.match(/NSAlert\(\)/g)?.length).toBe(2);
  expect(swift).toContain("page.onLoaded = { [weak self] in self?.reached(origin) }");
  const html = await Bun.file(new URL("unreachable.html", picker)).text();
  expect([...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1])).toEqual(["mac-unreachable.js"]);
  expect(html).toContain('href="picker.css"');
  expect([...html.matchAll(/<button type="button" class="([^"]+)">([^<]+)</g)].map((match) => [match[1], match[2]])).toEqual([
    ["secondary quit", "Quit"], ["secondary switch", "Switch Workspace"], ["primary retry", "Try Again"],
  ]);
  const script = await Bun.file(new URL("mac-unreachable.js", picker)).text();
  expect(script).toContain("retry.focus();");
  expect(script).toContain("slircPicker?.postMessage(");
});

test("on the unreachable screen Tab cycles the buttons, Enter presses the focused one, Escape switches", () => {
  expect(unreachableKey("Tab", false, 2, 3)).toEqual({ focus: 0 });
  expect(unreachableKey("Tab", false, 0, 3)).toEqual({ focus: 1 });
  expect(unreachableKey("Tab", true, 0, 3)).toEqual({ focus: 2 });
  expect(unreachableKey("Tab", false, -1, 3)).toEqual({ focus: 0 });
  expect(unreachableKey("Enter", false, 1, 3)).toEqual({ press: 1 });
  expect(unreachableKey("Enter", false, -1, 3)).toEqual({ post: "retry" });
  expect(unreachableKey("Escape", false, 2, 3)).toEqual({ post: "switch" });
  expect(unreachableKey("a", false, 2, 3)).toBeNull();
});

test("the focus ring is lime, the current row has the Current pill and no outline", async () => {
  const sheets = [
    await Bun.file(new URL("../public/style.css", import.meta.url)).text(),
    await Bun.file(new URL("picker.css", picker)).text(),
  ];
  for (const css of sheets) {
    const focus = css.split("\n").find((line) => line.includes(".workspace-row.kb-focus:focus") && line.includes("outline"));
    expect(focus).toContain("outline: 2px solid var(--brand)");
    for (const line of css.split("\n").filter((line) => line.includes('[aria-current="true"]'))) expect(line).not.toContain("outline");
    expect(css).toMatch(/\.workspace-current \{[^}]*color: var\(--brand\)/);
  }
  const script = await Bun.file(new URL("mac-picker.js", picker)).text();
  expect(script).toContain('end.className = "workspace-current"');
  expect(script).toContain('end.textContent = "Current"');
});

test("self-hosted origins work in the Mac picker and ShellWebView restricts in-app navigation to the active workspace origin", async () => {
  const rows = pickerRows(["https://chat.example.com"], "https://chat.example.com");
  expect(rows[0]).toMatchObject({ origin: "https://chat.example.com", name: "chat", letter: "C", label: "chat.example.com", saved: true, selected: true });
  expect(label("https://chat.example.com")).toBe("chat.example.com");

  const swift = await Bun.file(new URL("../../desktop/Slirc/AppDelegate.swift", import.meta.url)).text();
  const isWorkspaceFn = swift.slice(swift.indexOf("private func isWorkspace("), swift.indexOf("private func openOutside("));
  expect(isWorkspaceFn).toContain('url.scheme?.lowercased() == "https"');
  expect(isWorkspaceFn).toContain("url.user == nil");
  expect(isWorkspaceFn).toContain("url.password == nil");
  expect(isWorkspaceFn).toContain("(url.port ?? 443) == (workspace.port ?? 443)");
  expect(swift).toContain("openOutside(action.request.url)");
});

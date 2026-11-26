// The sidebar's workspace mark: a name from the host, the Slirc mark on app.slirc.org, and a
// monogram whose colour comes from the name alone.
import { expect, test } from "bun:test";
import { OPEN_WORKSPACE, WORKSPACE_PALETTE, animateListHeight, filterWorkspaces, workspaceChoices, workspaceMark, workspaceName, workspaceOrigin, workspaceRows } from "../client/workspace-mark.ts";

test("the name comes from the workspace's address", () => {
  expect(workspaceName("ai-guild.slirc.app")).toBe("ai-guild");
  expect(workspaceName("XMiro.slirc.app.")).toBe("xmiro");
  expect(workspaceName("calango.slirc.app:443")).toBe("calango");
  expect(workspaceName("dev.example.test:8443")).toBe("dev");
  expect(workspaceName("localhost:8080")).toBe("localhost");
});

test("app.slirc.org shows the Slirc mark", () => {
  expect(workspaceMark("app.slirc.org")).toMatchObject({ name: "Slirc", logo: "/icons/slirc.svg" });
});

test("any other workspace gets a monogram from its first letter", () => {
  const mark = workspaceMark("ai-guild.slirc.app");
  expect(mark).toMatchObject({ name: "ai-guild", letter: "A", logo: "" });
  expect(WORKSPACE_PALETTE).toContain(mark.color);
  expect(workspaceMark("9lives.slirc.app").letter).toBe("9");
});

test("each workspace's icon comes from its own origin; app.slirc.org keeps the Slirc mark", () => {
  expect(workspaceMark("ai-guild.slirc.app")).toMatchObject({ icon: "https://ai-guild.slirc.app/api/workspace-icon?size=64", iconReady: false });
  expect(workspaceMark("dev.example.test:8443", "https://dev.example.test:8443").icon).toBe("https://dev.example.test:8443/api/workspace-icon?size=64");
  expect(workspaceMark("app.slirc.org").icon).toBe("");
  const rows = workspaceChoices("https://ai-guild.slirc.app", ["https://xmiro.slirc.app"]);
  expect(rows.map((row) => row.icon)).toEqual(["https://ai-guild.slirc.app/api/workspace-icon?size=64", "https://xmiro.slirc.app/api/workspace-icon?size=64", ""]);
});

test("this workspace asks for its icon only when the shell says it has one", () => {
  expect(workspaceMark("ai-guild.slirc.app", "https://ai-guild.slirc.app", "")).toMatchObject({ icon: "", iconReady: false });
  expect(workspaceMark("ai-guild.slirc.app", "https://ai-guild.slirc.app", "1700000000000").icon).toBe("https://ai-guild.slirc.app/api/workspace-icon?size=64&v=1700000000000");
  expect(workspaceMark("app.slirc.org", "https://app.slirc.org", "17").icon).toBe("");
  expect(workspaceRows("https://ai-guild.slirc.app", [], workspaceMark("ai-guild.slirc.app", "https://ai-guild.slirc.app", ""))[0]!.icon).toBe("");
});

test("common names spread across the palette", () => {
  const colors = ["ai-guild", "xmiro", "calango", "juan", "jobs-test"].map((name) => workspaceMark(name + ".slirc.app").color);
  expect(new Set(colors).size).toBe(colors.length);
});

test("the colour depends only on the name, and two J names stay apart", () => {
  expect(workspaceMark("juan.slirc.app").color).toBe(workspaceMark("JUAN.slirc.app").color);
  expect(workspaceMark("juan.slirc.app").letter).toBe(workspaceMark("jobs-test.slirc.app").letter);
  expect(workspaceMark("juan.slirc.app").color).not.toBe(workspaceMark("jobs-test.slirc.app").color);
});

test("a typed address means one https origin, as in the iOS picker", () => {
  expect(workspaceOrigin("ai-guild")).toBe("https://ai-guild.slirc.app");
  expect(workspaceOrigin(" AI-Guild.slirc.app. ")).toBe("https://ai-guild.slirc.app");
  expect(workspaceOrigin("https://chat.example.com/x?y")).toBe("https://chat.example.com");
  expect(workspaceOrigin("http://ai-guild.slirc.app")).toBeNull();
  expect(workspaceOrigin("ai-guild.slirc.app:444")).toBeNull();
  expect(workspaceOrigin("me@ai-guild.slirc.app")).toBeNull();
  expect(workspaceOrigin("")).toBeNull();
});

test("the dialog lists this workspace first, then the app's saved ones, then app.slirc.org", () => {
  const rows = workspaceChoices("https://ai-guild.slirc.app", ["https://xmiro.slirc.app", "https://ai-guild.slirc.app", "not a host", "xmiro"]);
  expect(rows.map((row) => [row.origin, row.current])).toEqual([
    ["https://ai-guild.slirc.app", true],
    ["https://xmiro.slirc.app", false],
    [OPEN_WORKSPACE, false],
  ]);
  expect(rows[0]).toMatchObject({ name: "ai-guild", letter: "A", host: "ai-guild.slirc.app" });
  expect(rows[2]).toMatchObject({ name: "Slirc", note: "Slirc's own workspace" });
  expect(workspaceChoices(OPEN_WORKSPACE, []).map((row) => row.origin)).toEqual([OPEN_WORKSPACE]);
  // Self-hosted instances do not inject app.slirc.org into their workspace switcher.
  expect(workspaceChoices("https://chat.example.com", ["https://other.example.com"]).map((row) => row.origin)).toEqual([
    "https://chat.example.com",
    "https://other.example.com",
  ]);
  // Custom-port self-hosted instances also stay neutral and do not inject app.slirc.org.
  expect(workspaceChoices("https://dev.example.test:8443", []).map((row) => row.origin)).toEqual([
    "https://dev.example.test:8443",
  ]);
});

test("the sidebar mark shows only the badge, and the phone's More screen opens the same dialog", async () => {
  const read = (name: string) => Bun.file(new URL(`../partials/${name}`, import.meta.url)).text();
  const mark = (await read("header.html")).match(/<button[^>]*class="workspace-mark"[^>]*>.*?<\/button>/)?.[0] ?? "";
  expect(mark).toContain('x-on:click="openWorkspaces()"');
  expect(mark).not.toContain("workspace-name");
  expect(mark).not.toContain("chevron");
  expect(mark).not.toContain("disabled");
  const more = (await read("mobile-navigation.html")).split('data-phone-screen="more"')[1] ?? "";
  // One attribute per line or all on one: the row is the button with the workspace-row-more class.
  const row = more.match(/<button[^>]*class="mobile-row workspace-row-more"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  expect(row).toContain('x-on:click="openWorkspaces()"');
  expect(row.match(/^<button[^>]*>/)?.[0]).not.toContain("x-show");
  expect(more.indexOf("more-profile-row")).toBeLessThan(more.indexOf("workspace-row-more"));
  const dialog = await read("workspace-dialog.html");
  expect(dialog).toContain("pickWorkspace(item.origin)");
  expect(dialog).toMatch(/x-show="item.current">Current</);
  expect(dialog).not.toContain("'check'");
});

test("the rail rows carry this workspace's loaded icon, the dialog rows do too", () => {
  const mark = { icon: "https://ai-guild.slirc.app/api/workspace-icon?size=64&v=1", iconReady: true };
  const rows = workspaceRows("https://ai-guild.slirc.app", ["https://xmiro.slirc.app"], mark);
  expect(rows.map((row) => row.origin)).toEqual(["https://ai-guild.slirc.app", "https://xmiro.slirc.app", OPEN_WORKSPACE]);
  expect(rows[0]).toMatchObject({ current: true, icon: mark.icon, iconReady: true, logo: "" });
  expect(rows[1]).toMatchObject({ current: false, icon: "https://xmiro.slirc.app/api/workspace-icon?size=64", iconReady: false });
});

test("the instance rail switches workspace, marks the current one and opens the dialog", async () => {
  const read = (name: string) => Bun.file(new URL(`../partials/${name}`, import.meta.url)).text();
  const rail = await read("instance-rail.html");
  const item = rail.match(/<button[^>]*class="instance-rail-item"[^>]*>/)?.[0] ?? "";
  expect(item).toContain('x-on:click="pickWorkspace(item.origin)"');
  expect(rail).toContain('x-for="item in workspaceChoices"');
  expect(rail).toContain('class="instance-rail-pill"');
  expect(rail).toContain('item.current && \'active\'');
  expect(rail).toContain(':data-tooltip="item.name"');
  expect(rail).toContain('x-tooltip');
  expect(rail).toContain('class="workspace-badge"');
  const add = rail.match(/<button[^>]*instance-rail-add[^>]*>/)?.[0] ?? "";
  expect(add).toContain('x-on:click="openWorkspaces()"');
  expect(add).toContain('aria-haspopup="dialog"');
  expect(await read("index.html")).toContain("<!-- include: instance-rail -->");
});

test("typing in the dialog's field narrows the rows by name and host", () => {
  const rows = workspaceChoices("https://ai-guild.slirc.app", ["https://xmiro.slirc.app", "https://chat.example.com"]);
  const origins = (query: string) => filterWorkspaces(rows, query).rows.map((row) => row.origin);
  expect(origins("")).toEqual(rows.map((row) => row.origin));
  expect(origins("  ")).toEqual(rows.map((row) => row.origin));
  expect(origins("XM")).toEqual(["https://xmiro.slirc.app"]);
  expect(origins("example.com")).toEqual(["https://chat.example.com"]);
  expect(origins("slirc")).toEqual(["https://ai-guild.slirc.app", "https://xmiro.slirc.app", OPEN_WORKSPACE]);
  expect(origins("https://xmiro")).toEqual(["https://xmiro.slirc.app"]);
  expect(filterWorkspaces(rows, "xm").open).toBeNull();
});

test("with no row left, the dialog offers to open the typed address", () => {
  const rows = workspaceChoices("https://ai-guild.slirc.app", []);
  expect(filterWorkspaces(rows, "acme")).toEqual({ rows: [], open: { origin: "https://acme.slirc.app", label: "acme.slirc.app" } });
  expect(filterWorkspaces(rows, " Chat.Acme.io/x ").open).toEqual({ origin: "https://chat.acme.io", label: "chat.acme.io" });
  expect(filterWorkspaces(rows, "not a host").open).toEqual({ origin: null, label: "not a host" });
});

test("the dialog's field sits above the list, and the separate Open button is gone", async () => {
  const dialog = await Bun.file(new URL("../partials/workspace-dialog.html", import.meta.url)).text();
  expect(dialog.indexOf('id="workspace-address"')).toBeLessThan(dialog.indexOf('class="workspace-list"'));
  expect(dialog).toContain('x-for="(item, index) in workspaceFilter().rows"');
  expect(dialog).toContain('x-if="workspaceFilter().open"');
  expect(dialog).toMatch(/id="workspace-address"[^>]* autofocus /);
  expect(dialog).toContain("$el.querySelector('#workspace-address')?.focus()");
  expect(dialog).not.toContain(":autofocus");
  expect(dialog).toContain("animateListHeight($el)");
  expect(dialog).not.toContain('type="submit"');
  expect(dialog).not.toContain("Open another workspace");
});

test("the list animates its height between filter results, not on first render or reduced motion", () => {
  let height = 200;
  const runs: Array<{ frames: unknown; options: unknown }> = [];
  const el = { style: { overflow: "" }, getBoundingClientRect: () => ({ height }), animate: (frames: unknown, options: unknown) => { const run = { frames, options, onfinish: null as null | (() => void), oncancel: null }; runs.push(run); return run; } } as unknown as HTMLElement;
  animateListHeight(el, false);
  expect(runs).toHaveLength(0);
  height = 60;
  animateListHeight(el, false);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ frames: [{ height: "200px" }, { height: "60px" }], options: { duration: 180, easing: "ease-out" } });
  expect(el.style.overflow).toBe("hidden");
  (runs[0] as unknown as { onfinish: () => void }).onfinish();
  expect(el.style.overflow).toBe("");
  animateListHeight(el, false);
  expect(runs).toHaveLength(1);
  height = 120;
  animateListHeight(el, true);
  expect(runs).toHaveLength(1);
  height = 0;
  animateListHeight(el, false);
  height = 200;
  animateListHeight(el, false);
  expect(runs).toHaveLength(1);
});

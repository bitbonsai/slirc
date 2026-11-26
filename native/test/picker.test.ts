import { describe, expect, test } from "bun:test";
import { hosts as DEFAULT_HOSTS } from "../hosts.ts";
import "../www/picker.js";

type Check = "yes" | "no" | "unknown";
type Http = { get: (options: Record<string, unknown>) => Promise<{ status: number; data: unknown }> };
type Store = { workspaces: string[]; last: string | null };
type Raw = { workspaces: string | null; last: string | null; legacy: string | null };
type Next = { open: string; url?: string; store: Store } | { show: string | null; message: string; failed?: string; store: Store };
const picker = (globalThis as unknown as {
  slircPicker: {
    NOT_FOUND: string;
    UNREACHABLE: string;
    couldntReach: (origin: string) => string;
    unreachableOrigin: (value: unknown, hosts: string[]) => string | null;
    workspaceOrigin: (value: unknown) => string | null;
    opens: (origin: string, hosts: string[]) => boolean;
    isWorkspace: (http: Http | undefined, origin: string, timeout: number) => Promise<Check>;
    readStore: (raw: Raw, hosts: string[]) => { store: Store; changed: boolean };
    addWorkspace: (store: Store, origin: string) => Store;
    removeWorkspace: (store: Store, origin: string) => Store;
    OPEN_WORKSPACE: string;
    offersOpenWorkspace: (store: Store, hosts: string[]) => boolean;
    filterWorkspaces: (origins: string[], query: string) => { matches: string[]; open: { origin: string | null; label: string } | null };
    linkTarget: (value: unknown, hosts: string[]) => { origin: string; url: string } | null;
    launch: (deps: {
      load: () => Promise<Raw>;
      persist: (store: Store) => Promise<void>;
      check: (origin: string) => Promise<Check>;
      hosts: string[];
      params: URLSearchParams;
    }) => Promise<Next>;
  };
}).slircPicker;

const HOSTS = ["*"];
const RESTRICTED = ["*.slirc.app", "app.slirc.org"];
const SELF_HOSTED = "https://chat.example.com";

describe("workspaceOrigin", () => {
  test("a bare name gets .slirc.app", () => {
    expect(picker.workspaceOrigin("ai-guild")).toBe("https://ai-guild.slirc.app");
  });

  test("a full host and a pasted URL with a path give the same origin", () => {
    for (const value of ["ai-guild.slirc.app", "https://ai-guild.slirc.app", "https://ai-guild.slirc.app/some/path?x=1#y", "ai-guild.slirc.app/dm/ada"]) {
      expect(picker.workspaceOrigin(value)).toBe("https://ai-guild.slirc.app");
    }
    for (const value of ["chat.example.com", "https://chat.example.com", "https://chat.example.com/channels?x=1#y", "chat.example.com/dm/ada"]) {
      expect(picker.workspaceOrigin(value)).toBe(SELF_HOSTED);
    }
  });

  test("upper case, outer spaces and a trailing dot are normalised", () => {
    expect(picker.workspaceOrigin("  HTTPS://AI-Guild.Slirc.App/  ")).toBe("https://ai-guild.slirc.app");
    expect(picker.workspaceOrigin("ai-guild.slirc.app.")).toBe("https://ai-guild.slirc.app");
    expect(picker.workspaceOrigin("ai-guild.")).toBe("https://ai-guild.slirc.app");
    expect(picker.workspaceOrigin("  HTTPS://Chat.Example.COM./  ")).toBe(SELF_HOSTED);
  });

  test("other schemes, ports, userinfo, spaces and empty input are refused", () => {
    for (const value of [
      "http://ai-guild.slirc.app",
      "http://chat.example.com",
      "ftp://ai-guild.slirc.app",
      "javascript://ai-guild.slirc.app",
      "file:///etc/passwd",
      "ai-guild.slirc.app:443",
      "https://ai-guild.slirc.app:8443/",
      "https://chat.example.com:8443/",
      "https://me@ai-guild.slirc.app",
      "https://me:secret@ai-guild.slirc.app",
      "https://me@chat.example.com",
      "ai guild",
      "ai-guild .slirc.app",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(picker.workspaceOrigin(value)).toBeNull();
    }
  });

  test("malformed labels are refused", () => {
    for (const value of ["-ai-guild", "ai-guild-", "ai_guild", "ai..guild.slirc.app", ".slirc.app", "//ai-guild.slirc.app"]) {
      expect(picker.workspaceOrigin(value)).toBeNull();
    }
  });
});

describe("opens", () => {
  test("default hosts allows any valid https origin", () => {
    expect(DEFAULT_HOSTS).toEqual(["*"]);
    expect(picker.opens(SELF_HOSTED, DEFAULT_HOSTS)).toBe(true);
    expect(picker.opens("https://ai-guild.slirc.app", DEFAULT_HOSTS)).toBe(true);
    expect(picker.opens("https://app.slirc.org", DEFAULT_HOSTS)).toBe(true);
    expect(picker.opens("http://chat.example.com", DEFAULT_HOSTS)).toBe(false);
    expect(picker.opens("javascript:alert(1)", DEFAULT_HOSTS)).toBe(false);
  });

  test("a restricted list matches * as exactly one label", () => {
    expect(picker.opens("https://ai-guild.slirc.app", RESTRICTED)).toBe(true);
    expect(picker.opens("https://a.b.slirc.app", RESTRICTED)).toBe(false);
    expect(picker.opens("https://slirc.app", RESTRICTED)).toBe(false);
  });

  test("a restricted list matches app.slirc.org only to itself", () => {
    expect(picker.opens("https://app.slirc.org", RESTRICTED)).toBe(true);
    expect(picker.opens("https://beta.slirc.org", RESTRICTED)).toBe(false);
    expect(picker.opens("https://x.app.slirc.org", RESTRICTED)).toBe(false);
    expect(picker.opens("https://slirc.org", RESTRICTED)).toBe(false);
  });

  test("other domains and look-alikes are refused by a restricted list", () => {
    for (const origin of ["https://example.com", "https://ai-guild.slirc.app.evil.com", "https://ai-guild.slirc.apps", "https://ai-guildslirc.app"]) {
      expect(picker.opens(origin, RESTRICTED)).toBe(false);
    }
  });

  test("an empty list opens nothing", () => {
    expect(picker.opens("https://ai-guild.slirc.app", [])).toBe(false);
    expect(picker.opens(SELF_HOSTED, [])).toBe(false);
  });
});

describe("isWorkspace", () => {
  const answering = (status: number, data: unknown) => {
    const calls: Record<string, unknown>[] = [];
    const http: Http = { get: async (options) => { calls.push(options); return { status, data }; } };
    return { http, calls };
  };
  const check = (http: Http | undefined) => picker.isWorkspace(http, "https://ai-guild.slirc.app", 3000);

  test("a 200 with a hex version is yes", async () => {
    expect(await check(answering(200, { version: "e951224e" }).http)).toBe("yes");
  });

  test("asks /api/version for JSON with redirects off and the given timeout", async () => {
    const { http, calls } = answering(200, { version: "e951224e" });
    await check(http);
    expect(calls).toEqual([{
      url: "https://ai-guild.slirc.app/api/version",
      headers: { Accept: "application/json" },
      responseType: "json",
      disableRedirects: true,
      connectTimeout: 3000,
      readTimeout: 3000,
    }]);
  });

  test("a JSON body delivered as a string still parses", async () => {
    expect(await check(answering(200, '{"version":"e951224e"}').http)).toBe("yes");
  });

  test("a 200 with HTML, no version or a non-hex version is no", async () => {
    for (const data of ["<!doctype html><title>Slirc</title>", { version: "" }, { version: "v1.2.3" }, { version: "abc" }, { other: 1 }, null]) {
      expect(await check(answering(200, data).http)).toBe("no");
    }
  });

  test("a 404 or a redirect is no", async () => {
    expect(await check(answering(404, "Not found").http)).toBe("no");
    expect(await check(answering(301, "").http)).toBe("no");
  });

  test("a 5xx, a thrown error and a missing plugin are unknown", async () => {
    expect(await check(answering(500, { version: "e951224e" }).http)).toBe("unknown");
    expect(await check(answering(503, "").http)).toBe("unknown");
    expect(await check({ get: async () => { throw new Error("offline"); } })).toBe("unknown");
    expect(await check(undefined)).toBe("unknown");
  });
});

const AI = "https://ai-guild.slirc.app";
const ORG = "https://app.slirc.org";
const raw = (workspaces: unknown, last: string | null = null, legacy: string | null = null): Raw => ({
  workspaces: workspaces === null ? null : JSON.stringify(workspaces), last, legacy,
});

describe("readStore", () => {
  test("nothing stored is an empty store that needs no write", () => {
    expect(picker.readStore(raw(null), HOSTS)).toEqual({ store: { workspaces: [], last: null }, changed: false });
  });

  test("the single value from earlier builds becomes the list and the last used one", () => {
    expect(picker.readStore(raw(null, null, AI), HOSTS)).toEqual({ store: { workspaces: [AI], last: AI }, changed: true });
  });

  test("a legacy value that fails the checks is dropped, and the legacy key still gets cleared", () => {
    expect(picker.readStore(raw(null, null, "http://ai-guild.slirc.app"), HOSTS)).toEqual({ store: { workspaces: [], last: null }, changed: true });
  });

  test("a stored list and last used one read back as they are", () => {
    expect(picker.readStore(raw([AI, ORG], ORG), HOSTS)).toEqual({ store: { workspaces: [AI, ORG], last: ORG }, changed: false });
  });

  test("bad entries are dropped and duplicates merged", () => {
    const { store, changed } = picker.readStore(raw([AI, "garbage value", "http://chat.example.com", "https://chat.example.com:8443", 42, null, "AI-GUILD", SELF_HOSTED, ORG]), HOSTS);
    expect(store).toEqual({ workspaces: [AI, SELF_HOSTED, ORG], last: null });
    expect(changed).toBe(true);
  });

  test("a last used one missing from the list, or invalid, is cleared", () => {
    expect(picker.readStore(raw([AI], ORG), HOSTS).store).toEqual({ workspaces: [AI], last: null });
    expect(picker.readStore(raw([AI], "http://chat.example.com"), HOSTS).store).toEqual({ workspaces: [AI], last: null });
  });

  test("a list that is not a JSON array reads as empty", () => {
    for (const workspaces of ["not json", '{"a":1}', '"https://ai-guild.slirc.app"']) {
      expect(picker.readStore({ workspaces, last: null, legacy: null }, HOSTS)).toEqual({ store: { workspaces: [], last: null }, changed: true });
    }
  });
});

describe("addWorkspace and removeWorkspace", () => {
  test("adding appends and makes it the last used one", () => {
    expect(picker.addWorkspace({ workspaces: [AI], last: AI }, ORG)).toEqual({ workspaces: [AI, ORG], last: ORG });
  });

  test("adding a saved one keeps the order and only changes the last used one", () => {
    expect(picker.addWorkspace({ workspaces: [AI, ORG], last: ORG }, AI)).toEqual({ workspaces: [AI, ORG], last: AI });
  });

  test("removing the last used one clears it", () => {
    expect(picker.removeWorkspace({ workspaces: [AI, ORG], last: ORG }, ORG)).toEqual({ workspaces: [AI], last: null });
  });

  test("removing another one keeps the last used one", () => {
    expect(picker.removeWorkspace({ workspaces: [AI, ORG], last: ORG }, AI)).toEqual({ workspaces: [ORG], last: ORG });
  });
});

describe("launch", () => {
  const run = async (stored: Raw, answer: Check = "yes", query = "") => {
    const writes: Store[] = [];
    const checked: string[] = [];
    const next = await picker.launch({
      load: async () => stored,
      persist: async (store) => { writes.push(store); },
      check: async (origin) => { checked.push(origin); return answer; },
      hosts: HOSTS,
      params: new URLSearchParams(query),
    });
    return { next, writes, checked };
  };

  test("the last used workspace opens", async () => {
    const { next, writes, checked } = await run(raw([AI, ORG], ORG));
    expect(next).toEqual({ open: ORG, store: { workspaces: [AI, ORG], last: ORG } });
    expect(writes).toEqual([]);
    expect(checked).toEqual([ORG]);
  });

  test("the single value from earlier builds is migrated and opens", async () => {
    const { next, writes } = await run(raw(null, null, AI));
    expect(next).toEqual({ open: AI, store: { workspaces: [AI], last: AI } });
    expect(writes).toEqual([{ workspaces: [AI], last: AI }]);
  });

  test("nothing saved shows an empty picker without a check", async () => {
    const { next, writes, checked } = await run(raw(null));
    expect(next).toEqual({ show: null, message: "", store: { workspaces: [], last: null } });
    expect(writes).toEqual([]);
    expect(checked).toEqual([]);
  });

  test("saved workspaces with no last used one show the picker", async () => {
    const { next, checked } = await run(raw([AI, ORG]));
    expect(next).toEqual({ show: null, message: "", store: { workspaces: [AI, ORG], last: null } });
    expect(checked).toEqual([]);
  });

  test("a bad stored entry is dropped and written back", async () => {
    for (const legacy of ["garbage value", "http://ai-guild.slirc.app", "https://chat.example.com:8443", "https://me@chat.example.com"]) {
      const { next, writes, checked } = await run(raw(null, null, legacy));
      expect(next).toEqual({ show: null, message: "", store: { workspaces: [], last: null } });
      expect(writes).toEqual([{ workspaces: [], last: null }]);
      expect(checked).toEqual([]);
    }
  });

  test("a saved self-hosted workspace opens after /api/version succeeds", async () => {
    const { next, writes, checked } = await run(raw([SELF_HOSTED], SELF_HOSTED));
    expect(next).toEqual({ open: SELF_HOSTED, store: { workspaces: [SELF_HOSTED], last: SELF_HOSTED } });
    expect(writes).toEqual([]);
    expect(checked).toEqual([SELF_HOSTED]);
  });

  test("no forgets that workspace and shows the picker with it filled in", async () => {
    const madeUp = "https://zq-made-up-7x.slirc.app";
    const { next, writes } = await run(raw([AI, madeUp], madeUp), "no");
    expect(next).toEqual({ show: madeUp, message: picker.NOT_FOUND, store: { workspaces: [AI], last: null } });
    expect(writes).toEqual([{ workspaces: [AI], last: null }]);
  });

  test("unknown still opens the workspace", async () => {
    const { next, writes } = await run(raw([AI], AI), "unknown");
    expect(next).toEqual({ open: AI, store: { workspaces: [AI], last: AI } });
    expect(writes).toEqual([]);
  });

  test("?pick shows the picker without a check", async () => {
    const { next, checked } = await run(raw([AI, ORG], ORG), "yes", "pick=1");
    expect(next).toEqual({ show: null, message: "", store: { workspaces: [AI, ORG], last: ORG } });
    expect(checked).toEqual([]);
  });

  test("?unreachable shows the picker with the unreachable message and keeps the workspace", async () => {
    const { next, writes, checked } = await run(raw([AI], AI), "no", "unreachable=1");
    expect(next).toEqual({ show: null, message: picker.UNREACHABLE, store: { workspaces: [AI], last: AI } });
    expect(writes).toEqual([]);
    expect(checked).toEqual([]);
  });

  test("?unreachable=<origin> marks that workspace and keeps every saved one", async () => {
    const { next, writes, checked } = await run(raw([AI, ORG], AI), "yes", "unreachable=" + encodeURIComponent(AI));
    expect(next).toEqual({ show: null, message: picker.couldntReach(AI), failed: AI, store: { workspaces: [AI, ORG], last: AI } });
    expect(picker.couldntReach(AI)).toBe("We couldn't reach ai-guild.slirc.app. Try again, or pick another workspace.");
    expect(writes).toEqual([]);
    expect(checked).toEqual([]);
  });

  test("?unreachable with something other than a full allowed origin falls back to the plain message", async () => {
    for (const value of ["1", "ai-guild", "http://ai-guild.slirc.app", "https://ai-guild.slirc.app/", "https://ai-guild.slirc.app:8443", "javascript:alert(1)"]) {
      const { next } = await run(raw([AI], AI), "yes", "unreachable=" + encodeURIComponent(value));
      expect(next).toEqual({ show: null, message: picker.UNREACHABLE, store: { workspaces: [AI], last: AI } });
    }
    expect(picker.unreachableOrigin(SELF_HOSTED, RESTRICTED)).toBeNull();
  });

  test("a storage error ends on an empty picker", async () => {
    const next = await picker.launch({
      load: async () => { throw new Error("storage"); },
      persist: async () => {},
      check: async () => "yes",
      hosts: HOSTS,
      params: new URLSearchParams(),
    });
    expect(next).toEqual({ show: null, message: "", store: { workspaces: [], last: null } });
  });
});

describe("linkTarget", () => {
  test("an https link on an allowed host keeps its path, query and fragment", () => {
    expect(picker.linkTarget("https://ai-guild.slirc.app/j/abc?x=1#y", HOSTS)).toEqual({ origin: "https://ai-guild.slirc.app", url: "https://ai-guild.slirc.app/j/abc?x=1#y" });
    expect(picker.linkTarget("https://app.slirc.org/pair#o=secret", HOSTS)).toEqual({ origin: "https://app.slirc.org", url: "https://app.slirc.org/pair#o=secret" });
    expect(picker.linkTarget("https://chat.example.com/j/abc?x=1#y", HOSTS)).toEqual({ origin: SELF_HOSTED, url: SELF_HOSTED + "/j/abc?x=1#y" });
  });

  test("a slirc:// link opens the same page over https", () => {
    expect(picker.linkTarget("slirc://ai-guild.slirc.app/#feedback", HOSTS)).toEqual({ origin: "https://ai-guild.slirc.app", url: "https://ai-guild.slirc.app/#feedback" });
    expect(picker.linkTarget("slirc://ai-guild.slirc.app", HOSTS)).toEqual({ origin: "https://ai-guild.slirc.app", url: "https://ai-guild.slirc.app/" });
    expect(picker.linkTarget("slirc://ai-guild.slirc.app/dm/ada", HOSTS)?.url).toBe("https://ai-guild.slirc.app/dm/ada");
    expect(picker.linkTarget("slirc://ai-guild/channels", HOSTS)?.url).toBe("https://ai-guild.slirc.app/channels");
    expect(picker.linkTarget("slirc://chat.example.com/#feedback", HOSTS)).toEqual({ origin: SELF_HOSTED, url: SELF_HOSTED + "/#feedback" });
  });

  test("a slirc:// link never opens a page that carries a token", () => {
    for (const link of [
      "slirc://ai-guild.slirc.app/pair#o=secret",
      "slirc://ai-guild.slirc.app/pair/123456",
      "slirc://ai-guild.slirc.app/?pair=123456",
      "slirc://ai-guild.slirc.app/j/token",
      "slirc://ai-guild.slirc.app/join/token",
      "slirc://ai-guild.slirc.app/auth/verify?token=x",
      "slirc://ai-guild.slirc.app/admission#token=x",
      "slirc://ai-guild.slirc.app/dm/ada/extra",
      "slirc://chat.example.com/pair#o=secret",
      "slirc://chat.example.com/auth/verify?token=x",
    ]) expect(picker.linkTarget(link, HOSTS)).toBeNull();
  });

  test("other schemes, ports, userinfo and disallowed hosts are refused", () => {
    for (const link of [
      "http://ai-guild.slirc.app/",
      "http://chat.example.com/",
      "https://ai-guild.slirc.app:8443/",
      "https://chat.example.com:8443/",
      "https://me@ai-guild.slirc.app/",
      "https://me@chat.example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(picker.linkTarget(link, HOSTS)).toBeNull();
    }
    expect(picker.linkTarget("https://chat.example.com/", RESTRICTED)).toBeNull();
    expect(picker.linkTarget("slirc://chat.example.com/", RESTRICTED)).toBeNull();
  });
});

describe("launch with a link", () => {
  const run = async (stored: Raw, link: string, answer: Check = "yes") => {
    const writes: Store[] = [];
    const next = await picker.launch({
      load: async () => stored,
      persist: async (store) => { writes.push(store); },
      check: async () => answer,
      hosts: HOSTS,
      params: new URLSearchParams({ link }),
    });
    return { next, writes };
  };

  test("a link to a new workspace saves it and opens the page", async () => {
    const { next, writes } = await run(raw([ORG], ORG), "https://ai-guild.slirc.app/j/abc");
    expect(next).toEqual({ open: AI, url: AI + "/j/abc", store: { workspaces: [ORG, AI], last: AI } });
    expect(writes).toEqual([{ workspaces: [ORG, AI], last: AI }]);
  });

  test("switching to another saved workspace keeps every saved one and only changes the last used one", async () => {
    const XM = "https://xmiro.slirc.app";
    const { next, writes } = await run(raw([AI, ORG, XM], AI), ORG + "/");
    expect(next).toEqual({ open: ORG, url: ORG + "/", store: { workspaces: [AI, ORG, XM], last: ORG } });
    expect(writes).toEqual([{ workspaces: [AI, ORG, XM], last: ORG }]);
  });

  test("a switch while the saved list cannot be read opens the workspace and writes nothing", async () => {
    const writes: Store[] = [];
    const next = await picker.launch({
      load: async () => { throw new Error("storage"); },
      persist: async (store) => { writes.push(store); },
      check: async () => "yes",
      hosts: HOSTS,
      params: new URLSearchParams({ link: ORG + "/" }),
    });
    expect(next).toEqual({ open: ORG, url: ORG + "/", store: { workspaces: [], last: null } });
    expect(writes).toEqual([]);
  });

  test("a link to a host that is not a workspace shows the picker and saves nothing", async () => {
    const { next, writes } = await run(raw([ORG], ORG), "https://zq-made-up.slirc.app/", "no");
    expect(next).toEqual({ show: "https://zq-made-up.slirc.app", message: picker.NOT_FOUND, store: { workspaces: [ORG], last: ORG } });
    expect(writes).toEqual([]);
  });

  test("a refused slirc:// link is ignored and the last workspace opens", async () => {
    const { next, writes } = await run(raw([ORG], ORG), "slirc://ai-guild.slirc.app/auth/verify?token=x");
    expect(next).toEqual({ open: ORG, store: { workspaces: [ORG], last: ORG } });
    expect(writes).toEqual([]);
  });
});

describe("offersOpenWorkspace", () => {
  test("app.slirc.org is offered until it is saved", () => {
    expect(picker.OPEN_WORKSPACE).toBe(ORG);
    expect(picker.offersOpenWorkspace({ workspaces: [], last: null }, HOSTS)).toBe(true);
    expect(picker.offersOpenWorkspace({ workspaces: [AI], last: AI }, HOSTS)).toBe(true);
    expect(picker.offersOpenWorkspace({ workspaces: [AI, ORG], last: AI }, HOSTS)).toBe(false);
  });

  test("it is not offered when the build does not allow that host", () => {
    expect(picker.offersOpenWorkspace({ workspaces: [], last: null }, ["*.slirc.app"])).toBe(false);
  });

  test("removing it offers it again", () => {
    const store = picker.removeWorkspace({ workspaces: [AI, ORG], last: ORG }, ORG);
    expect(picker.offersOpenWorkspace(store, HOSTS)).toBe(true);
  });
});

describe("iOS navigation origin policy and picker copy", () => {
  test("capacitor.config.ts keeps allowNavigation empty so external links open in Safari", async () => {
    const configSource = await Bun.file(new URL("../capacitor.config.ts", import.meta.url)).text();
    expect(configSource).toContain("allowNavigation: []");
    expect(configSource).not.toContain("allowNavigation: hosts");
    expect(configSource).not.toContain('allowNavigation: ["*"]');
  });

  test("BridgeViewController.swift allows only active workspace origin in-app and keeps openWorkspace local-only", async () => {
    const swift = await Bun.file(new URL("../ios/App/App/BridgeViewController.swift", import.meta.url)).text();
    expect(swift).toContain("override func shouldOverrideLoad(_ navigationAction: WKNavigationAction)");
    expect(swift).toContain("workspaceState.isActiveOrigin(url)");
    expect(swift).toContain("@objc func openWorkspace(_ call: CAPPluginCall)");
    const allowedBlock = swift.match(/let workspaceBridgeMethods: Set<String> = \[[^\]]*\]/)?.[0] ?? "";
    expect(allowedBlock).toContain("SlircShell.switchWorkspace");
    expect(allowedBlock).not.toContain("openWorkspace");
  });

  test("picker UI accepts any host and routes opens through SlircShell.openWorkspace", async () => {
    const html = await Bun.file(new URL("../www/index.html", import.meta.url)).text();
    expect(html).not.toContain("This app opens slirc.app workspaces");
    expect(html).toContain('placeholder="yourteam or chat.example.com"');
    expect(html).toContain("shell.openWorkspace({ url })");
  });
});

describe("iOS load watch", () => {
  const swift = () => Bun.file(new URL("../ios/App/App/BridgeViewController.swift", import.meta.url)).text();

  test("a workspace gets 5 s to answer and 5 s more to start its client", async () => {
    const source = await swift();
    expect(source).toContain("static let timeout: TimeInterval = 5");
    expect(source).toContain("loadWatch.start(url, in: bridge.webView)");
    expect(source).toContain("loadWatch.didCommit(webView)");
    // The client removes "booting" from <html> once it starts (app/client/runtime.ts).
    expect(source).toContain("!!document.querySelector('[data-client-root]') && !document.documentElement.classList.contains('booting')");
  });

  test("a missed deadline or a failed load shows the picker with that workspace", async () => {
    const source = await swift();
    expect(source).toContain('showPicker(query: "unreachable", value: origin)');
    expect(source.match(/if loadWatch\.didFail\(\) \{ return \}/g)?.length).toBe(2);
  });

  test("cancelled loads are still ignored", async () => {
    const source = await swift();
    expect(source).toContain("error.code == NSURLErrorCancelled");
    expect(source.indexOf("Ignored a cancelled load")).toBeLessThan(source.indexOf("if loadWatch.didFail() { return }"));
  });

  test("the client still marks its boot the way the watch reads it", async () => {
    const partial = await Bun.file(new URL("../../app/partials/index.html", import.meta.url)).text();
    const runtime = await Bun.file(new URL("../../app/client/runtime.ts", import.meta.url)).text();
    expect(partial).toContain('<html lang="en" class="booting">');
    expect(partial).toContain("data-client-root");
    expect(runtime).toContain('root.classList.toggle("booting", on);');
  });

  test("the picker offers Try again and marks the failed card", async () => {
    const html = await Bun.file(new URL("../www/index.html", import.meta.url)).text();
    expect(html).toContain(">Try again</button>");
    expect(html).toContain('"Couldn\'t reach"');
    expect(html).toContain('navigateToWorkspace(failed + "/")');
  });

  test("the opening screen shows only the logomark, and the files it names ship", async () => {
    const html = await Bun.file(new URL("../www/index.html", import.meta.url)).text();
    const opening = html.slice(html.indexOf('<div class="opening"'), html.indexOf("</div>", html.indexOf('<div class="opening"')));
    const files = [...opening.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((match) => match[1]);
    expect(files.sort()).toEqual(["mark-dark.webp", "mark-light.webp"]);
    for (const name of files) expect(await Bun.file(new URL("../www/" + name, import.meta.url)).exists()).toBe(true);
    expect(html.indexOf("opening(url);")).toBeGreaterThan(html.indexOf("async function navigateToWorkspace(url) {"));
  });
});

describe("filterWorkspaces", () => {
  const saved = ["https://ai-guild.slirc.app", "https://xmiro.slirc.app", SELF_HOSTED, picker.OPEN_WORKSPACE];
  test("an empty field keeps every card", () => {
    expect(picker.filterWorkspaces(saved, " ")).toEqual({ matches: saved, open: null });
  });
  test("typing narrows the cards by name and host", () => {
    expect(picker.filterWorkspaces(saved, "XM").matches).toEqual(["https://xmiro.slirc.app"]);
    expect(picker.filterWorkspaces(saved, "example").matches).toEqual([SELF_HOSTED]);
    expect(picker.filterWorkspaces(saved, "slirc").matches).toEqual(["https://ai-guild.slirc.app", "https://xmiro.slirc.app", picker.OPEN_WORKSPACE]);
    expect(picker.filterWorkspaces(saved, "xm").open).toBeNull();
  });
  test("with no card left it offers the typed address", () => {
    expect(picker.filterWorkspaces(saved, "acme")).toEqual({ matches: [], open: { origin: "https://acme.slirc.app", label: "acme.slirc.app" } });
    expect(picker.filterWorkspaces(saved, "not a host").open).toEqual({ origin: null, label: "not a host" });
  });
  test("the picker has no separate Add a workspace button", async () => {
    const html = await Bun.file(new URL("../www/index.html", import.meta.url)).text();
    expect(html).not.toContain("Add a workspace");
    expect(html).toContain('"Open " + typed.label');
    expect(html).toContain("if (store.workspaces.length && !failed) input.focus();");
  });
});

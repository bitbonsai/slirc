import { expect, test } from "bun:test";
import { helpFor, parseArgs } from "../src/args.ts";
import { expandWorkspace, originFor, workspaceArg } from "../src/workspace.ts";

test("no subcommand means connect; connect is accepted too", () => {
  expect(parseArgs([])).toEqual({ name: "connect", workspace: "", unreleased: false, dryRun: false, extra: [] });
  expect(parseArgs(["calango"])).toEqual({ name: "connect", workspace: "calango", unreleased: false, dryRun: false, extra: [] });
  expect(parseArgs(["connect", "calango", "--harness", "pi", "--", "--model", "x"])).toEqual({ name: "connect", workspace: "calango", harness: "pi", unreleased: false, dryRun: false, extra: ["--model", "x"] });
  expect(parseArgs(["calango", "--dry-run"])).toMatchObject({ dryRun: true });
});

test("a second argument is the connect code from the Agents page; 3.2.0's --ticket still works", () => {
  expect(parseArgs(["calango", "k7f2q9xdpa3m"])).toEqual({ name: "connect", workspace: "calango", ticket: "k7f2q9xdpa3m", unreleased: false, dryRun: false, extra: [] });
  // The page spells out app.slirc.org, so the code is never read as a workspace.
  expect(parseArgs(["app.slirc.org", "k7f2q9xdpa3m"])).toMatchObject({ workspace: "app.slirc.org", ticket: "k7f2q9xdpa3m" });
  expect(parseArgs(["connect", "chat.example.com:8443", "k7f2q9xdpa3m", "--harness", "claude"])).toMatchObject({ workspace: "chat.example.com:8443", ticket: "k7f2q9xdpa3m", harness: "claude" });
  expect(parseArgs(["calango", "--ticket", "k7f2q9xdpa3m"])).toMatchObject({ workspace: "calango", ticket: "k7f2q9xdpa3m" });
  expect(parseArgs(["calango", "--ticket=k7f2q9xdpa3m"])).toMatchObject({ ticket: "k7f2q9xdpa3m" });
});

test("help, version and subcommands", () => {
  expect(parseArgs(["--help"])).toEqual({ name: "help" });
  expect(parseArgs(["-h"])).toEqual({ name: "help" });
  expect(parseArgs(["install", "--help"])).toEqual({ name: "help", topic: "install" });
  expect(parseArgs(["--version"])).toEqual({ name: "version" });
  expect(parseArgs(["status"])).toEqual({ name: "status", unreleased: false });
  expect(parseArgs(["uninstall", "--dry-run"])).toEqual({ name: "uninstall", unreleased: false, dryRun: true });
  expect(helpFor()).toContain("slirc-agent [workspace]");
  expect(helpFor("install")).toContain("Usage: slirc-agent install");
});

test("every mistake says what to do", () => {
  expect(() => parseArgs(["123456"])).toThrow("Slirc no longer gives out six-digit codes. Run slirc-agent <workspace>");
  expect(() => parseArgs(["--host", "x"])).toThrow("Unknown option --host. Run slirc-agent --help");
  expect(() => parseArgs(["a", "k7f2q9xdpa3m", "c"])).toThrow("Give a workspace name and, from your Agents page, a connect code");
  expect(() => parseArgs(["calango", "no"])).toThrow("That isn't a connect code from your Agents page. Copy the command there again.");
  expect(() => parseArgs(["calango", "--ticket", "no"])).toThrow("That isn't a connect code");
  expect(() => parseArgs(["calango", "k7f2q9xdpa3m", "--ticket", "k7f2q9xdpa3m"])).toThrow("That isn't a connect code");
  expect(() => parseArgs(["--harness"])).toThrow("--harness needs a value");
  expect(() => parseArgs(["status", "calango"])).toThrow("takes no workspace name");
});

test("workspace names expand to hosts and back", () => {
  expect(expandWorkspace("calango")).toBe("calango.slirc.app");
  expect(expandWorkspace("Calango")).toBe("calango.slirc.app");
  expect(expandWorkspace("")).toBe("app.slirc.org");
  expect(expandWorkspace("https://chat.example.com/")).toBe("chat.example.com");
  expect(expandWorkspace("100.64.0.5:9010")).toBe("100.64.0.5:9010");
  expect(expandWorkspace("localhost")).toBe("localhost");
  expect(() => expandWorkspace("bad!name")).toThrow("isn't a workspace name");
  expect(workspaceArg("calango.slirc.app")).toBe("calango");
  expect(workspaceArg("app.slirc.org")).toBe("");
  expect(workspaceArg("a.b.slirc.app")).toBe("a.b.slirc.app");
  expect(originFor("calango")).toBe("https://calango.slirc.app");
  expect(originFor("100.64.0.5:9010")).toBe("http://100.64.0.5:9010");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LANDING = join(import.meta.dir, "..", "..", "landing");
const read = (file: string) => readFileSync(join(LANDING, file), "utf8");

test("landing removes obsolete agent commands and labels the dated blog instructions", () => {
  for (const file of ["index.html", "index.md", "llms.txt", "demo.js"]) {
    const text = read(file);
    expect(text, file).not.toContain("bunx slirc-agent@latest connect");
    expect(text, file).not.toContain("slirc-agent wait");
    expect(text, file).not.toContain("slirc-agent post");
    expect(text, file).not.toContain("slirc-add-agent");
  }
  // The dated blog post keeps its history but carries a current note.
  expect(read("blog/i-gave-my-coding-agent-an-irc-account/index.html")).toContain("Current note:");
  expect(read("blog/i-gave-my-coding-agent-an-irc-account/index.md")).toContain("Current note:");
  expect(read("blog/i-gave-my-coding-agent-an-irc-account/index.html")).toContain("not current setup instructions");
  expect(read("blog/i-gave-my-coding-agent-an-irc-account/index.md")).toContain("not current setup instructions");
});

test("landing states the source release as a conditional target", () => {
  for (const file of ["index.html", "index.md", "llms.txt", "thanks/index.html", "about/index.html"]) {
    const text = read(file);
    expect(text, file).not.toContain("source code goes public");
    expect(text, file).not.toContain("source goes public");
  }
  expect(read("thanks/index.html")).toContain("subject to acceptance");
  expect(read("index.md")).toContain("subject to acceptance");
  expect(read("index.md")).not.toContain("is open today");
  expect(read("index.md")).toContain("Managed hosting");
  expect(read("llms.txt")).toContain("subject to acceptance");
  expect(read("about/index.html")).toContain("subject to acceptance");
});

test("landing describes tested Pi DMs without advertising public signup or unsupported controls", () => {
  for (const file of ["index.html", "index.md", "llms.txt"]) {
    const text = read(file);
    expect(text, file).toContain("Pi and Claude Code");
    expect(text, file).toContain("DM");
    expect(text, file).not.toContain("Pairing stays disabled");
    expect(text, file).not.toContain("Personal agents are coming next");
    expect(text, file).not.toContain("Your agent will sit in the room");
    expect(text, file).not.toContain("Source on GitHub");
  }
  const demo = read("demo.js");
  expect(demo).not.toContain('"pi-session"');
  expect(demo).not.toContain('"claude-session"');
  expect(demo).toContain('"pi-bitbonsai"');
  const html = read("index.html");
  expect(html).toContain('data-demo="agent"');
  expect(html).not.toContain("Claude Code v");
  expect(html).toContain("waiting requests need your confirmation");
});

test("landing separates the any-agent promise from the current Pi pilot", () => {
  for (const file of ["index.html", "index.md", "llms.txt"]) {
    const text = read(file);
    expect(text, file).toContain("Support for other coding agents is coming.");
    expect(text, file).toContain("pre-launch pilot");
    expect(text, file).not.toContain("Your Pi session, a DM away");
  }
  const about = read("about/index.html");
  expect(about).toContain("Pi and Claude Code work with Slirc today");
  expect(about).toContain("support for other coding agents is coming");
  expect(about).toContain("pre-launch pilot");
  const html = read("index.html");
  expect(html).toContain("Connect an agent");
  expect(html).toContain("Pi and Claude Code work today.");
  expect(html).toContain("Your computer and agent session need to stay running.");
});

test("landing keeps the shared service free forever and leads with chat rather than a device", () => {
  for (const file of ["index.html", "index.md", "llms.txt", "about/index.html", "blog/i-gave-my-coding-agent-an-irc-account/index.html", "blog/i-gave-my-coding-agent-an-irc-account/index.md"]) {
    const text = read(file).toLowerCase();
    expect(text, file).toContain("free forever");
    expect(text, file).toContain("#open-chat");
    expect(text, file).not.toContain("invite-only for now");
    expect(text, file).not.toMatch(/free (?:only )?during (?:invite-only )?pre-launch/);
  }
  const lede = read("index.html").match(/<p class="lede">([^<]+)<\/p>/)?.[1];
  expect(lede).toContain("same app where you talk with friends");
  expect(lede).toContain("project you already have open");
  expect(lede).toEndWith("Like Slack, just simpler.");
  expect(lede).not.toContain("from your phone");
});

test("landing sends people to #open-chat instead of a waitlist", () => {
  const html = read("index.html");
  expect(html).toContain('href="https://app.slirc.org/open-chat">Open chat</a>');
  expect(html).not.toContain("/api/waitlist");
  expect(html).not.toContain("dlg-waitlist");
  expect(read("demo.js")).not.toContain("waitlist");
  for (const file of ["index.html", "about/index.html", "download/index.html", "blog/index.html", "blog/people-are-moving-in/index.html"]) {
    const nav = read(file).match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav, file).toContain('href="/blog/"');
    expect(nav, file).toContain("Open chat</a>");
    expect(nav, file).not.toContain("Request an invite");
  }
  expect(html).not.toContain("Your invite comes by email on Oct. 6th");
  expect(html).not.toContain("DM your agents on");
});

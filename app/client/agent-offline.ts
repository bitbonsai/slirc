// The offline notice an agent posts in its owner's DM when its session goes away. On the wire it is
// a plain line (so IRC clients read it as text) carrying the client-only tag +slirc/agent-offline,
// which the server sets. Anyone can put a client-only tag on their own message, so a card is shown
// only for a tagged line from the agent itself, in the DM with that agent, whose text has the exact
// shape the server writes. Anything else renders as an ordinary message.

export const AGENT_OFFLINE_TAG = "+slirc/agent-offline";

export type AgentOfflineCard = {
  title: string; // "Claude Code session offline"
  command: string; // what to run, as one line to copy, or "" when the session can't be named
  lines: string[]; // the command as shown: `cd <folder>` and `claude --resume <id>` on their own lines
  hint: string; // where to run it, or what to do without a command
};

const NOTICE = /^My (?:(.{1,40}) )?session went offline\. (.{1,400}) to bring me back\. To delete me, use Remove on \S+$/;
const ID = "[A-Za-z0-9_-]{1,128}";
const FOLDER = "(?:[\\w@%+=:,./-]+|'(?:[^']|'\\\\'')*')";
const IN_FOLDER = new RegExp(`^Run (cd ${FOLDER} && claude --resume ${ID})$`);
const NO_FOLDER = new RegExp(`^Run (claude --resume ${ID}) in the folder it ran in$`);
const PI = new RegExp(`^Run (pi --session ${ID})$`);

// Split at the `&&` so the id never wraps and nothing dangles; the copy keeps the one line.
const shown = (command: string) => command.split(" && ");

// A card shows only while it is that agent's newest one and the agent is still away. Once the agent
// is back (attached now, or a newer card proves it came back in between), the card leaves the
// transcript: presence already shows on the avatar dot, so a returning agent adds no line.
export function agentOfflineFolded(message: { authorNick: string }, later: { authorNick: string; isCard: boolean }[], attached: boolean): boolean {
  const same = (nick: string) => nick.toLowerCase() === message.authorNick.toLowerCase();
  return attached || later.some((item) => same(item.authorNick) && item.isCard);
}

// One "back online" toast when the agent whose DM is on screen returns: never after a blip under
// BACK_BLIP_MS, and at most one per agent every BACK_TOAST_GAP_MS. Keys are folded nicks.
export const BACK_BLIP_MS = 30_000;
export const BACK_TOAST_GAP_MS = 5 * 60_000;
export function createAgentBackToast(now: () => number = Date.now) {
  const awaySince = new Map<string, number>();
  const toldAt = new Map<string, number>();
  return (key: string, attached: boolean, viewing: boolean): boolean => {
    const at = now();
    if (!attached) { if (!awaySince.has(key)) awaySince.set(key, at); return false; }
    const since = awaySince.get(key);
    awaySince.delete(key);
    if (since === undefined || at - since < BACK_BLIP_MS || !viewing) return false;
    if (at - (toldAt.get(key) ?? -Infinity) < BACK_TOAST_GAP_MS) return false;
    toldAt.set(key, at);
    return true;
  };
}

export function agentOfflineCard(message: { notice?: string; text: string; authorNick: string }, dmPeer: string | null, isAgent: (nick: string) => boolean): AgentOfflineCard | null {
  if (message.notice !== "agent-offline") return null;
  if (!dmPeer || dmPeer.toLowerCase() !== message.authorNick.toLowerCase() || !isAgent(message.authorNick)) return null;
  const match = NOTICE.exec(message.text);
  if (!match) return null;
  const title = match[1] ? `${match[1]} session offline` : "Session offline";
  const back = match[2]!;
  const folder = IN_FOLDER.exec(back) ?? PI.exec(back);
  if (folder) return { title, command: folder[1]!, lines: shown(folder[1]!), hint: "Run this in a terminal to bring it back." };
  const loose = NO_FOLDER.exec(back);
  if (loose) return { title, command: loose[1]!, lines: [loose[1]!], hint: "Run this in the folder it ran in to bring it back." };
  if (back === "Resume it in the folder it ran in") return { title, command: "", lines: [], hint: "Resume it in the folder it ran in to bring it back." };
  return null;
}

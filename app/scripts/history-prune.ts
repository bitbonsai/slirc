// Remove app-client noise from Ergo's persistent history.
//
//   bun scripts/history-prune.ts prune '#calango' ['#other' ...]   delete configured oper join/part/mode/topic events
//   bun scripts/history-prune.ts events '#calango' [...]           delete every join/part/mode/topic/kick event, any nick
//   bun scripts/history-prune.ts clear '#help' ['#open-chat' ...]  delete every item in a channel's history
//   add --dry-run to list what would go.
//
// NICK and QUIT rows always stay: their msgid is shared with every channel the user was in, and
// stock HistServ DELETE can remove another channel's copy (see src/history.ts).
//
// Needs ERGO_HOST, ERGO_PORT, ERGO_OPER_USER, ERGO_OPER_PASS (same env the app uses). Runs from the app
// container in production: podman exec -it <app> bun scripts/history-prune.ts prune '#calango'
//
// The pager and per-msgid HistServ DELETE live in src/history.ts, shared with the app's
// channel-teardown path so both use one sequence.

import { ergoOperUser } from "../src/config.ts";
import { operClient } from "../src/grants.ts";
import { deleteHistoryMsgid, sajoinRefusal, scanChannelHistory, sharedHistoryEvent } from "../src/history.ts";

const operUser = ergoOperUser();
if (!process.env.ERGO_OPER_PASS) throw new Error("ERGO_OPER_PASS required");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [mode, ...channels] = args.filter((arg) => arg !== "--dry-run");
if (!["prune", "events", "clear"].includes(mode) || !channels.length) {
  console.error("usage: history-prune.ts prune|events|clear '#channel' [...] [--dry-run]");
  process.exit(2);
}

const EVENTS = new Set(["JOIN", "PART", "MODE", "TOPIC", "KICK"]);
const APP_NICK = new RegExp(`^${operUser}(-[0-9a-f]{6})?$`);
const nickOf = (prefix = "") => prefix.split("!")[0];

// SAJOIN needs oper rights, and a SASL login as the oper account alone is not an oper: operClient
// also sends OPER, like the app's own oper connections.
const client = await operClient(["batch", "message-tags", "server-time", "draft/chathistory", "draft/event-playback"]);
let failed = 0;

for (const channel of channels) {
  const refusal = await sajoinRefusal(client, channel);
  if (refusal) { failed++; console.log(`${channel}: could not join (${refusal}), skipped`); continue; }
  const targets: { msgid: string; line: string }[] = [];
  let total = 0;
  for await (const items of scanChannelHistory(client, channel)) {
    total += items.length;
    for (const m of items) {
      const wanted = sharedHistoryEvent(m) ? false : mode === "clear" ? true : mode === "events" ? EVENTS.has(m.command) : EVENTS.has(m.command) && APP_NICK.test(nickOf(m.prefix));
      if (wanted && m.tags.msgid) targets.push({ msgid: m.tags.msgid, line: `${m.tags.time || ""} ${m.command} ${nickOf(m.prefix)} ${m.params.slice(1).join(" ")}`.trim() });
    }
  }
  console.log(`${channel}: scanned ${total} items, ${targets.length} ${mode === "clear" ? "items" : mode === "events" ? "events" : "app events"} to delete`);
  for (const target of targets) {
    if (dryRun) { console.log(`  would delete ${target.line}`); continue; }
    const reply = await deleteHistoryMsgid(client, channel, target.msgid);
    if (process.env.PRUNE_VERBOSE || !reply) console.log(`  ${target.msgid}: ${reply || "no reply"} <- ${target.line}`);
  }
  if (!dryRun) console.log(`${channel}: deleted ${targets.length} ${mode === "clear" ? "items" : "events"}`);
  client.send(`PART ${channel}`);
}
client.quit();
// The join and delete timeouts leave timers behind; exit now instead of waiting them out.
process.exit(failed ? 1 : 0);

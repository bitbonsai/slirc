// One-off cleanup: saved copies made before comment threads were left out can hold what people
// wrote under a page. Each saved page is read again; its text is replaced only when the page
// still answers with text and has comments that are now left out. Without --write it only
// reports. --host narrows the run and can be repeated. Counts only are printed, never text.
//
//   podman exec <app container> bun src/links-recopy.ts [--host linkedin.com] [--write]
import { db } from "./db.ts";
import { linkHost, safeUrl } from "./links.ts";
import { HOST_DELAY_MS, rereadCopyWithoutComments, type Reread } from "./links-images.ts";

const args = process.argv.slice(2);
const write = args.includes("--write");
const only = args.flatMap((arg, i) => (arg === "--host" && args[i + 1] ? [args[i + 1].toLowerCase()] : []));
const HOSTS_AT_ONCE = 6;

const rows = db.query(`SELECT links.id, links.url FROM link_copies JOIN links ON links.id = link_copies.link_id
  WHERE link_copies.state = 'text' AND links.removed_at IS NULL ORDER BY links.id`).all() as { id: number; url: string }[];
const byHost = new Map<string, number[]>();
for (const row of rows) {
  const url = safeUrl(row.url);
  const host = url ? linkHost(url) : "";
  if (!host || (only.length && !only.includes(host))) continue;
  byHost.set(host, [...(byHost.get(host) ?? []), row.id]);
}

const counts = new Map<string, Record<Reread, number>>();
const queue = [...byHost.entries()];
let done = 0;
const total = queue.reduce((sum, [, ids]) => sum + ids.length, 0);
console.log(`${write ? "cleaning" : "dry run over"} ${total} saved pages on ${queue.length} hosts`);
async function worker(): Promise<void> {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [host, ids] = next;
    const tally: Record<Reread, number> = { cleaned: 0, unchanged: 0, unreadable: 0 };
    counts.set(host, tally);
    for (const [i, id] of ids.entries()) {
      if (i) await Bun.sleep(HOST_DELAY_MS);
      tally[await rereadCopyWithoutComments(id, { write })]++;
      if (++done % 100 === 0) console.log(`${done} of ${total} read`);
    }
  }
}
await Promise.all(Array.from({ length: HOSTS_AT_ONCE }, worker));

const sum = (key: Reread) => [...counts.values()].reduce((n, tally) => n + tally[key], 0);
for (const [host, tally] of [...counts.entries()].filter(([, tally]) => tally.cleaned || tally.unreadable).sort((a, b) => b[1].cleaned - a[1].cleaned)) {
  console.log(`${host}: ${tally.cleaned} ${write ? "cleaned" : "would be cleaned"}, ${tally.unreadable} could not be read again, ${tally.unchanged} unchanged`);
}
console.log(`${write ? "cleaned" : "would clean"} ${sum("cleaned")}; ${sum("unchanged")} had no comments; ${sum("unreadable")} could not be read again and keep their text`);

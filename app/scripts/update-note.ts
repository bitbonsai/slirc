// Post a short note to the open channel about what a deploy changed for users.
//
//   bun scripts/update-note.ts last                          print the last commit a note covered
//   bun scripts/update-note.ts facts                         print what this instance offers
//   echo "We fixed ..." | bun scripts/update-note.ts say [--dry-run]
//   bun scripts/update-note.ts record --to <sha>             mark <sha> as covered, posting nothing
//
// `say` posts the text on stdin as the `updates` bot as written and records nothing. Several lines
// go as one message. --dry-run prints the note and changes nothing.
//
// Runs in the app container, where the database and Ergo settings already are.

import { openRoom } from "../src/welcome.ts";
import { handNote, instanceFacts, lastCommit, postNote, recordCommit } from "../src/update-notes.ts";

const args = process.argv.slice(2);
const command = args[0];
const dryRun = args.includes("--dry-run");
const to = args[args.indexOf("--to") + 1] || "";

if (command === "last") {
  console.log(lastCommit() || "");
} else if (command === "facts") {
  console.log(instanceFacts());
} else if (command === "record" && /^[0-9a-f]{7,40}$/.test(to)) {
  recordCommit(to);
  console.log(`recorded ${to.slice(0, 8)} as covered`);
} else if (command === "say") {
  const note = handNote(await new Response(Bun.stdin.stream()).text());
  if (!dryRun) await postNote(openRoom(), note);
  console.log(dryRun ? note : `posted to ${openRoom()}:\n${note}`);
} else {
  console.error("usage: bun scripts/update-note.ts last | facts | say [--dry-run] < note | record --to <sha>");
  process.exit(2);
}

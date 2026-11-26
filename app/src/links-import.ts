// Load links from a CSV on standard input. An operator runs it inside the app container, so the
// file is never copied into the image or the checkout:
//
//   podman exec -i <app container> bun src/links-import.ts --dry-run < links.csv
//   podman exec -i <app container> bun src/links-import.ts < links.csv
//
// It prints counts and, for skipped rows, a line number and a reason. Never row content.
//
// --post queues a short post about the new links for LINKS_DIGEST_CHANNEL, which the `links`
// helper sends. With --dry-run it prints that post instead, above the counts.
import { importLinks, importRowsFromCsv } from "./links.ts";
import { linksHome } from "./links-collect.ts";
import { digestLines, libraryUrl, queueDigest, type AddedLink } from "./links-digest.ts";

const dryRun = process.argv.includes("--dry-run");
const post = process.argv.includes("--post");
const text = await Bun.stdin.text();
if (!text.trim()) {
  console.error("No input. Pipe the CSV in: bun src/links-import.ts < links.csv");
  process.exit(1);
}
let rows;
try {
  rows = importRowsFromCsv(text);
} catch (error) {
  console.error(error instanceof Error ? error.message : "The file could not be read.");
  process.exit(1);
}
const added: AddedLink[] = [];
const report = importLinks(rows, { dryRun, added });
const digest = post ? digestLines(added, libraryUrl(linksHome())) : [];
if (dryRun) for (const line of digest) console.log(line);
else queueDigest(digest);
for (const skipped of report.skipped.slice(0, 50)) console.log(`line ${skipped.line}: skipped, ${skipped.reason}`);
if (report.skipped.length > 50) console.log(`and ${report.skipped.length - 50} more skipped rows`);
console.log(`${dryRun ? "dry run, nothing written: " : ""}read ${report.read}, added ${report.added}, merged ${report.merged}, skipped ${report.skipped.length}, already imported ${report.alreadyImported}`);

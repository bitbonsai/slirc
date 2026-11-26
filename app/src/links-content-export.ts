// Write the content the links backfill has fetched (preview images, X posts, saved page text,
// site icons and the recorded misses) to one gzipped file, so another instance can load it without fetching
// everything again. Links from private channels are left out. The path is an argument; `-`
// writes to standard output, which is how it leaves a container:
//
//   podman exec <app container> bun src/links-content-export.ts - > links-content.ndjson.gz
//
// The file is an operator's artefact. Keep it outside the repo.
import { exportContent } from "./links-content.ts";

const path = process.argv[2];
if (!path) {
  console.error("Give the file to write, or - for standard output: bun src/links-content-export.ts <path>");
  process.exit(1);
}
const counts: Record<string, number> = { image: 0, post: 0, copy: 0, icon: 0 };
const lines: string[] = [];
for (const record of exportContent()) { counts[record.t]++; lines.push(JSON.stringify(record)); }
const packed = Bun.gzipSync(new TextEncoder().encode(lines.join("\n") + "\n"));
if (path === "-") await Bun.write(Bun.stdout, packed); else await Bun.write(path, packed);
console.error(`exported ${counts.image} image records, ${counts.post} posts, ${counts.copy} saved-text records, ${counts.icon} site icons, ${(packed.length / 1_048_576).toFixed(1)} MB`);

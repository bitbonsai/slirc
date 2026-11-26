// Load a file written by links-content-export.ts. It fills in only links that exist here and
// have nothing stored yet, never overwrites, and changes nothing on a second run. Run the links
// import first, so the links are there to match. The path is an argument; `-` reads standard
// input, which is how the file enters a container:
//
//   podman exec -i <app container> bun src/links-content-import.ts - < links-content.ndjson.gz
import { importContent } from "./links-content.ts";

const path = process.argv[2];
if (!path) {
  console.error("Give the file to read, or - for standard input: bun src/links-content-import.ts <path>");
  process.exit(1);
}
const packed = new Uint8Array(path === "-" ? await Bun.stdin.arrayBuffer() : await Bun.file(path).arrayBuffer());
let lines: string[];
try {
  lines = new TextDecoder().decode(Bun.gunzipSync(packed)).split("\n").filter(Boolean);
} catch {
  console.error("That is not a file written by links-content-export.ts.");
  process.exit(1);
}
function* records() {
  for (const line of lines) { try { yield JSON.parse(line); } catch { yield null; } }
}
const report = importContent(records());
console.log(`read ${report.read}: added ${report.images} image records, ${report.posts} posts, ${report.copies} saved-text records, ${report.icons} site icons; ${report.kept} already here, ${report.unknown} for links not on this instance, ${report.bad} unreadable`);

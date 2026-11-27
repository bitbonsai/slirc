import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in `pi` on PATH for harness module and CLI tests. It keeps its installed packages in a
// file, prints them the way `pi list` does (source, then the installed folder), and logs every call.
// Like the real one, `install` replaces any entry for the same package, and a failed one changes
// nothing. `notYet`: the first that many installs fail with npm's ETARGET, as right after a
// release. `broken`: every install fails another way. Nothing here touches the real Pi or the
// real home folder.
export type FakePi = { root: string; env: Record<string, string>; calls(): string[]; installed(): string[]; install(source: string, version?: string): void; done(): void };

export function fakePi(options: { version?: string; notYet?: number; broken?: boolean } = {}): FakePi {
  const root = mkdtempSync(join(tmpdir(), "slirc-fake-pi-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const db = join(root, "packages.json");
  const log = join(root, "calls.log");
  writeFileSync(db, "[]");
  writeFileSync(log, "");
  const tries = join(root, "install-tries");
  writeFileSync(tries, "0");
  const script = `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  --version) echo "${options.version ?? "1.5.2"}" ;;
  list) "${process.execPath}" -e 'const p=require("${db}");if(!p.length){console.log("No packages installed.");process.exit(0)}console.log("User packages:");for(const x of p){console.log("  "+x.source);console.log("    "+x.folder)}' ;;
  install)
    n=$(( $(cat "${tries}") + 1 )); echo "$n" > "${tries}"
    ${options.broken ? "echo \"npm error code E404\" >&2; echo \"Error: npm install failed with code 1\" >&2; exit 1" : ":"}
    if [ "$n" -le ${options.notYet ?? 0} ]; then echo "npm error code ETARGET" >&2; echo "npm error notarget No matching version found." >&2; exit 1; fi
    "${process.execPath}" -e 'const fs=require("fs");const p=require("${db}");const s=process.argv.at(-1);const name=s.replace(/^npm:/,"").replace(/@[^@]*$/,"");const v=(s.match(/@([0-9][^@]*)$/)||[])[1]||"0.0.0";const folder="${root}/pkgs/"+name;const same=(x)=>x.source.replace(/^npm:/,"").replace(/@[^@]*$/,"")===name;fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(folder+"/package.json",JSON.stringify({name,version:v}));fs.writeFileSync("${db}",JSON.stringify([...p.filter(x=>!same(x)),{source:s,folder}]))' "$2" ;;
  remove) "${process.execPath}" -e 'const fs=require("fs");const p=require("${db}");fs.writeFileSync("${db}",JSON.stringify(p.filter(x=>x.source!==process.argv.at(-1))))' "$2" ;;
  *) echo "launched pi SLIRC_CONNECT=$SLIRC_CONNECT\${SLIRC_CONNECT_TICKET:+ ticket=$SLIRC_CONNECT_TICKET} args=$*" ;;
esac
`;
  writeFileSync(join(bin, "pi"), script);
  chmodSync(join(bin, "pi"), 0o755);
  // PATH holds the fake and the system basics only, so no real pi, node or bun is found by name.
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(":"), HOME: home, XDG_STATE_HOME: join(root, "state"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent") };
  return {
    root, env,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    installed: () => JSON.parse(readFileSync(db, "utf8")).map((entry: { source: string }) => entry.source),
    install(source, version) {
      const name = source.replace(/^npm:/, "").replace(/@[^@]*$/, "");
      const folder = join(root, "pkgs", name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: version ?? (source.match(/@([0-9][^@]*)$/)?.[1] ?? "0.0.0") }));
      writeFileSync(db, JSON.stringify([...JSON.parse(readFileSync(db, "utf8")), { source, folder }]));
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

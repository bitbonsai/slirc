// Writes www/hosts.js from hosts.ts. The sync and ios scripts in package.json run this before
// cap sync, which copies www/ into the app.
import { writeFileSync } from "node:fs";
import { hostsPath, hostsScript } from "./hosts";

writeFileSync(hostsPath, hostsScript);

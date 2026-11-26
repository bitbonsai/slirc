import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Explicit opt-in: uses only harmless fixtures and local scratch image, no pull or live volumes.
test.skipIf(process.env.SLIRC_CONTAINER_TESTS !== "1")("actual COPY excludes secrets, state and host dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slirc-context-"));
  const image = `localhost/slirc-context-test:${crypto.randomUUID()}`;
  let container = "";
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(`${args[0]} ${args[1]}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const excluded = [".env", ".env.prod", "nested/.env.local", "chat.db", "chat.db-wal", "nested/chat.sqlite", "nested/chat.sqlite-shm", "nested/chat.sqlite3-wal", ".git/config", ".data/sentinel", "node_modules/host.js", "agent/node_modules/host.js", "src/node_modules/host.js", "test/sentinel", "tls.key", "tls.pem", "secrets/sentinel", "credentials.json"];
  const included = ["package.json", "bun.lock", "src/server.ts", "public/index.html", "public/docs/index.html", "docs/setup.md"];
  try {
    await copyFile(new URL("../.dockerignore", import.meta.url), join(dir, ".dockerignore"));
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\nCOPY . /context/\nCMD [\"/unused\"]\n");
    for (const path of [...excluded, ...included]) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), "harmless build-context sentinel\n");
    }
    run("podman", "build", "--pull=never", "--network=none", "-q", "-t", image, dir);
    container = run("podman", "create", image);
    const archive = join(dir, "export.tar");
    run("podman", "export", "-o", archive, container);
    const files = new Set(run("tar", "-tf", archive).split("\n"));
    for (const path of excluded) expect(files.has(`context/${path}`)).toBe(false);
    for (const path of included) expect(files.has(`context/${path}`)).toBe(true);
  } finally {
    if (container) run("podman", "rm", container);
    // Remove only this test's image; never prune the shared engine.
    Bun.spawnSync(["podman", "rmi", image], { stdout: "ignore", stderr: "ignore" });
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

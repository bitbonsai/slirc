// Alpine components registered as `() => client.x` return one shared object. Mounting the same name on two
// elements makes Alpine define $nextTick on that object twice and the whole shell fails to start.
import { expect, test } from "bun:test";

const main = await Bun.file(new URL("../client/main.ts", import.meta.url)).text();
const shell = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const shared = [...main.matchAll(/Alpine\.data\("(\w+)", \(\) => client\.\w+\)/g)].map((m) => m[1]!);

test("shared Alpine components are mounted at most once in the shell", () => {
  expect(shared.length).toBeGreaterThan(0);
  for (const name of shared) {
    const mounts = shell.split(`x-data="${name}"`).length - 1;
    expect(mounts, name).toBeLessThanOrEqual(1);
  }
});

// An x-if or x-for template remounts its content on every toggle, which re-runs init() on the same
// shared object and hits the same redefine error the second time a panel opens.
test("shared Alpine components are never mounted inside a template", async () => {
  const inside: string[] = [];
  let depth = 0;
  await new HTMLRewriter()
    .on("template", { element(el) { depth++; el.onEndTag(() => { depth--; }); } })
    .on("[x-data]", { element(el) { if (depth && shared.includes(el.getAttribute("x-data") ?? "")) inside.push(el.getAttribute("x-data")!); } })
    .transform(new Response(shell)).text();
  expect(inside).toEqual([]);
});

// A partial included from several places lands in the shell several times, so it must not carry a
// component mount, an init hook or an id.
test("partials included more than once carry no x-data, x-init or id", async () => {
  const dir = new URL("../partials/", import.meta.url);
  const counts = new Map<string, number>();
  for (const file of new Bun.Glob("*.html").scanSync(dir.pathname)) {
    const text = await Bun.file(new URL(file, dir)).text();
    for (const m of text.matchAll(/<!--\s*include:\s*([\w.-]+)\s*-->/g)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const repeated = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
  expect(repeated.length).toBeGreaterThan(0);
  for (const name of repeated) {
    const text = await Bun.file(new URL(`${name}.html`, dir)).text();
    expect(text, name).not.toMatch(/\sx-data=|\sx-init=|\sid="/);
  }
});

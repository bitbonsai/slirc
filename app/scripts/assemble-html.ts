// Assembles the delivered client shell from feature-sized HTML partials at build time. Source is
// app/partials/index.html with `<!-- include: name -->` markers; each marker is replaced verbatim
// with app/partials/<name>.html. No runtime HTML injection: the browser still receives one document.
// Run via `bun run assemble` (also chained by `bun run version`) after editing any partial.
const ROOT = new URL("../", import.meta.url);

// Pure include resolver so the recursion and cycle guard are testable without touching the tree.
export async function assemble(
  shell: string,
  read: (name: string) => Promise<string>,
): Promise<{ html: string; used: Set<string> }> {
  const used = new Set<string>();
  const resolve = async (text: string, stack: string[]): Promise<string> => {
    let out = text;
    for (const match of [...text.matchAll(/<!--\s*include:\s*([\w.-]+)\s*-->/g)]) {
      const name = match[1];
      if (stack.includes(name)) throw new Error(`partial cycle: ${[...stack, name].join(" -> ")}`);
      used.add(name);
      const body = await resolve(await read(name), [...stack, name]);
      out = out.replaceAll(`<!-- include: ${name} -->`, body.replace(/\n$/, ""));
    }
    return out;
  };
  return { html: await resolve(shell, ["index"]), used };
}

async function partialReader(name: string): Promise<string> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad partial name: ${name}`);
  const file = new URL(`./partials/${name}.html`, ROOT);
  if (!(await Bun.file(file).exists())) throw new Error(`missing partial: ${name}`);
  return Bun.file(file).text();
}

if (import.meta.main) {
  const shell = await Bun.file(new URL("./partials/index.html", ROOT)).text();
  const { html, used } = await assemble(shell, partialReader);
  await Bun.write(new URL("./public/index.html", ROOT), html);
  console.log(`assemble-html: ${used.size} partial(s) -> public/index.html`);
}

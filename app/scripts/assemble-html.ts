// Assembles the delivered client shell from feature-sized HTML partials at build time. Source is
// app/partials/index.html with `<!-- include: name -->` markers; each marker is replaced verbatim
// with app/partials/<name>.html. A marker may pass arguments, `<!-- include: name key=value -->`, which
// fill `{{key}}` in that partial. A value is bare, "double quoted" or 'single quoted', so one row
// partial serves every list. No runtime HTML injection: the browser still receives one document.
// The stylesheet is built the same way: app/styles/*.css, in filename order, are concatenated verbatim
// into public/style.css. The first file holds the boot:start/boot:end block, which must stay whole.
// Run via `bun run assemble` (also chained by `bun run version`) after editing any partial.
const ROOT = new URL("../", import.meta.url);

const INCLUDE = /<!--\s*include:\s*([\w.-]+)((?:\s+[\w-]+=(?:"[^"]*"|'[^']*'|[^\s"']+))*)\s*-->/g;

function args(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, key, quoted, single, bare] of text.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g)) out[key!] = quoted ?? single ?? bare ?? "";
  return out;
}

// Pure include resolver so the recursion and cycle guard are testable without touching the tree.
export async function assemble(
  shell: string,
  read: (name: string) => Promise<string>,
): Promise<{ html: string; used: Set<string> }> {
  const used = new Set<string>();
  const resolve = async (text: string, stack: string[]): Promise<string> => {
    let out = text;
    for (const match of [...text.matchAll(INCLUDE)]) {
      const name = match[1];
      if (stack.includes(name)) throw new Error(`partial cycle: ${[...stack, name].join(" -> ")}`);
      used.add(name);
      const given = args(match[2] ?? "");
      const raw = (await read(name)).replace(/\{\{([\w-]+)\}\}/g, (_, key: string) => {
        if (!(key in given)) throw new Error(`partial ${name} needs ${key}=`);
        return given[key]!;
      });
      const body = await resolve(raw, [...stack, name]);
      out = out.replaceAll(match[0], () => body.replace(/\n$/, ""));
    }
    return out;
  };
  return { html: await resolve(shell, ["index"]), used };
}

// Pure so the order and the boot-block guard are testable without touching the tree.
export function assembleStyles(files: { name: string; text: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const css = sorted.map((file) => file.text).join("");
  const start = css.indexOf("/* boot:start");
  const end = css.indexOf("/* boot:end */");
  if (start < 0 || end < start) throw new Error("styles: the boot:start / boot:end block is missing or out of order");
  return css;
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

  const styleDir = new URL("./styles/", ROOT);
  const names = [...new Bun.Glob("*.css").scanSync({ cwd: styleDir.pathname })];
  const styles = await Promise.all(names.map(async (name) => ({ name, text: await Bun.file(new URL(name, styleDir)).text() })));
  await Bun.write(new URL("./public/style.css", ROOT), assembleStyles(styles));
  console.log(`assemble-html: ${styles.length} stylesheet(s) -> public/style.css`);
}

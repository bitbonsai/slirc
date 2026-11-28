// Build-time HTML partial resolver: nested includes, verbatim substitution, and cycle detection.
// The browser still gets one document; this only decides how it is assembled from source.
import { expect, test } from "bun:test";

const { assemble, assembleStyles } = await import("../scripts/assemble-html.ts");

const reader = (files: Record<string, string>) => (name: string) => {
  if (!(name in files)) throw new Error(`missing partial: ${name}`);
  return Promise.resolve(files[name]);
};

test("replaces includes verbatim and resolves nesting", async () => {
  const { html, used } = await assemble("<body><!-- include: row --></body>", reader({
    row: "<div><!-- include: body --></div>",
    body: '<span class="body">hi</span>\n',
  }));
  expect(html).toBe('<body><div><span class="body">hi</span></div></body>');
  expect([...used].sort()).toEqual(["body", "row"]);
});

test("an include passes arguments into the partial's {{slots}}", async () => {
  const { html } = await assemble(
    `<!-- include: row name=item.nick lazy="" --><!-- include: row name=nick lazy='loading="lazy"' -->`,
    reader({ row: "<img {{lazy}} :src=\"url({{name}})\">\n" }),
  );
  expect(html).toBe('<img  :src="url(item.nick)"><img loading="lazy" :src="url(nick)">');
});

test("a slot nobody filled is an error, not leftover braces", async () => {
  await expect(assemble("<!-- include: row a=1 -->", reader({ row: "{{a}}{{b}}" }))).rejects.toThrow(/partial row needs b=/);
});

test("rejects an include cycle", async () => {
  const cycle = assemble("<!-- include: a -->", reader({ a: "<!-- include: b -->", b: "<!-- include: a -->" }));
  await expect(cycle).rejects.toThrow(/partial cycle: index -> a -> b -> a/);
});

test("surfaces a missing partial", async () => {
  await expect(assemble("<!-- include: nope -->", reader({}))).rejects.toThrow(/missing partial: nope/);
});

test("invitations partial has balanced HTML elements", async () => {
  const html = await Bun.file(new URL("../partials/invitations-page.html", import.meta.url)).text();
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack: string[] = [];
  for (const match of html.matchAll(/<!--[^]*?-->|<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
    if (match[0].startsWith("<!--")) continue;
    const tag = match[1]!.toLowerCase();
    if (match[0].startsWith("</")) {
      expect(stack.pop(), `closing </${tag}> must match the open element`).toBe(tag);
    } else if (!voidElements.has(tag) && !match[0].endsWith("/>")) {
      stack.push(tag);
    }
  }
  expect(stack, "all opened elements must be closed").toEqual([]);
});

test("an agent row reads DMs, rename, then remove", async () => {
  const html = await Bun.file(new URL("../partials/agents-page.html", import.meta.url)).text();
  const row = html.slice(html.indexOf('<li class="agent-row">'));
  const order = ["toggleReadDms", "askRename", "askRemove"].map((handler) => row.indexOf(handler));
  expect(order.every((at) => at > 0), "all three controls are in the row").toBe(true);
  expect(order, "DMs switch, then the rename pencil, then the trash").toEqual([...order].sort((a, b) => a - b));
  expect(row.slice(order[0]!).includes("<strong>DMs</strong>")).toBe(true);
});

// public/index.html is generated. An edit made there and not in a partial is lost on the next
// `bun run assemble`, so the committed shell must equal what the partials assemble to.
test("public/index.html matches the partials", async () => {
  const root = new URL("../", import.meta.url);
  const shell = await Bun.file(new URL("./partials/index.html", root)).text();
  const { html } = await assemble(shell, (name: string) => Bun.file(new URL(`./partials/${name}.html`, root)).text());
  expect(html === await Bun.file(new URL("./public/index.html", root)).text()).toBe(true);
});

// public/style.css is generated the same way: edit app/styles/*.css, then `bun run assemble`.
test("public/style.css matches the stylesheets", async () => {
  const dir = new URL("../styles/", import.meta.url);
  const names = [...new Bun.Glob("*.css").scanSync({ cwd: dir.pathname })];
  const files = await Promise.all(names.map(async (name) => ({ name, text: await Bun.file(new URL(name, dir)).text() })));
  expect(assembleStyles(files) === await Bun.file(new URL("../public/style.css", import.meta.url)).text()).toBe(true);
});

test("stylesheets join in filename order, whatever order they are listed in", () => {
  const boot = { name: "01-a.css", text: "/* boot:start */\na{}\n/* boot:end */\n" };
  const rest = { name: "02-b.css", text: "b{}\n" };
  expect(assembleStyles([rest, boot])).toBe(boot.text + rest.text);
});

test("the boot block must survive the split", () => {
  expect(() => assembleStyles([{ name: "01-a.css", text: "a{}\n" }])).toThrow("boot:start");
  expect(() => assembleStyles([{ name: "01-a.css", text: "/* boot:end */\n/* boot:start */\n" }])).toThrow("boot:start");
});

// Build-time HTML partial resolver: nested includes, verbatim substitution, and cycle detection.
// The browser still gets one document; this only decides how it is assembled from source.
import { expect, test } from "bun:test";

const { assemble } = await import("../scripts/assemble-html.ts");

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

// public/index.html is generated. An edit made there and not in a partial is lost on the next
// `bun run assemble`, so the committed shell must equal what the partials assemble to.
test("public/index.html matches the partials", async () => {
  const root = new URL("../", import.meta.url);
  const shell = await Bun.file(new URL("./partials/index.html", root)).text();
  const { html } = await assemble(shell, (name: string) => Bun.file(new URL(`./partials/${name}.html`, root)).text());
  expect(html === await Bun.file(new URL("./public/index.html", root)).text()).toBe(true);
});

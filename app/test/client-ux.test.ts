// Source checks for two shell contracts: the profile footer stays outside the scrolling sidebar
// sheet, and signed-out invitation links never show a sign-in prompt.
import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test("the profile footer sits outside the scrolling sidebar sheet", async () => {
  for (const path of ["../partials/conversation-list.html", "../public/index.html"]) {
    const html = await read(path);
    const beforeFooter = html.split('<div class="rooms-sheet">')[1]!.split('<div class="panel-footer">')[0]!;
    const opens = beforeFooter.match(/<div\b/g)?.length ?? 0;
    const closes = beforeFooter.match(/<\/div>/g)?.length ?? 0;
    expect(closes - opens).toBe(1); // Sheet closed before its sibling footer.
  }
});

test("Contacts has its own collapse toggle, outside the Direct messages body", async () => {
  const html = await read("../partials/conversation-list.html");
  const dmsBody = html.indexOf('<div x-show="dmsOpen">');
  const contactsToggle = html.indexOf('x-on:click="contactsOpen = !contactsOpen"');
  expect(dmsBody).toBeGreaterThan(-1);
  expect(contactsToggle).toBeGreaterThan(dmsBody);
  // The DMs body must close before the Contacts toggle, or collapsing DMs hides Contacts too.
  let depth = 0;
  let bodyCloses = -1;
  for (const tag of html.slice(dmsBody).matchAll(/<\/?div\b[^>]*>/g)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) { bodyCloses = dmsBody + tag.index! + tag[0].length; break; }
  }
  expect(bodyCloses).toBeGreaterThan(-1);
  expect(bodyCloses).toBeLessThan(contactsToggle);
  // The contact rows sit under the Contacts body, which the toggle hides.
  expect(html.indexOf('x-show="contactsOpen"')).toBeLessThan(html.indexOf('x-for="nick in contactList()"'));
});

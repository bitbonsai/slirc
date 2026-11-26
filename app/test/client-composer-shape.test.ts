// Editing on a phone: there is no Esc key, so the edit label carries a Cancel button bound to
// cancelEdit(); desktop keeps the "Esc to cancel" hint instead.
import { expect, test } from "bun:test";

test("the phone edit label has a Cancel button wired to cancelEdit; desktop keeps Esc to cancel", async () => {
  const partial = await Bun.file(new URL("../partials/composer.html", import.meta.url)).text();
  const markup = partial.match(/<p class="composer-editing"[\s\S]*?<\/p>/)?.[0] ?? "";
  expect(markup).toMatch(/<span x-show="isDesktop">[^<]*Esc to cancel<\/span>/);
  expect(markup).toMatch(/<button type="button"[^>]*x-show="!isDesktop"[^>]*x-on:click="cancelEdit\(\)"/);
});

// The phone DMs list sits at the bottom of the screen like Home, with Notes leading it.
import { expect, test } from "bun:test";

test("phone DMs spacer comes before Notes so no gap opens between Notes and Agents", async () => {
  const mobile = await Bun.file(new URL("../partials/mobile-navigation.html", import.meta.url)).text();
  const dms = mobile.split('data-phone-screen="dms"')[1]!.split('data-phone-screen="more"')[0]!;
  const spacer = dms.indexOf('class="mobile-spacer"');
  const notes = dms.indexOf("notes-row");
  expect(spacer).toBeGreaterThan(-1);
  expect(notes).toBeGreaterThan(spacer);
  expect(dms.indexOf('class="mobile-spacer"', spacer + 1)).toBe(-1);
});

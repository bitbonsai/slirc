import { expect, test } from "bun:test";
import { parseRoute, routeUrl } from "@client/navigation.ts";

const ORIGIN = "https://app.slirc.org";

test("an old /clients link, which used to show Devices, now opens the IRC tab", () => {
  expect(parseRoute("/clients", ORIGIN)).toEqual({ kind: "irc" });
  expect(parseRoute(ORIGIN + "/clients/", ORIGIN)).toEqual({ kind: "irc" });
  expect(routeUrl({ kind: "irc" })).toBe("/clients");
  expect(parseRoute("/settings", ORIGIN)).toEqual({ kind: "settings" });
});

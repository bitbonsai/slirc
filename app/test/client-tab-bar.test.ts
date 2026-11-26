// The phone tab bar lights one tab per screen; the More tab stays lit on every page it opens.
import { expect, test } from "bun:test";
import { tabBarComponent, tabIsActive, type Tab, type TabBarState } from "@client/tab-bar.ts";

const routes = ["profileRoute", "settingsRoute", "channelsRoute", "invitationsRoute", "ircRoute", "agentsRoute", "adminRoute"] as const;
const tabs: Tab[] = ["home", "dms", "more"];

function state(over: Partial<TabBarState> = {}): TabBarState {
  return { mobileNav: null, profileRoute: false, settingsRoute: false, channelsRoute: false, invitationsRoute: false, ircRoute: false, agentsRoute: false, adminRoute: false, ...over };
}
const lit = (ui: TabBarState) => tabs.filter((tab) => tabIsActive(tab, ui));

test("each tab screen lights its own tab", () => {
  for (const tab of tabs) expect(lit(state({ mobileNav: tab }))).toEqual([tab]);
});

test("every page opened from More keeps More lit", () => {
  for (const route of routes) expect(lit(state({ [route]: true })), route).toEqual(["more"]);
});

test("a conversation lights no tab", () => {
  expect(lit(state())).toEqual([]);
});

test("the component reads the surrounding scope and opens the tapped tab", () => {
  const opened: string[] = [];
  const scope = {
    ...tabBarComponent(),
    ...state({ settingsRoute: true }),
    openHome: () => opened.push("home"),
    openDms: () => opened.push("dms"),
    openMore: () => opened.push("more"),
  };
  expect(scope.isActive("more")).toBe(true);
  expect(scope.isActive("home")).toBe(false);
  for (const tab of tabs) scope.select(tab);
  expect(opened).toEqual(["home", "dms", "more"]);
});

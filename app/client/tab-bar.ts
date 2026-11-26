// Phone tab bar: which of the three tabs is lit and what a tap opens. Mounted on the nav inside the
// client scope, so `this` reaches mobileNav, the route flags and the open* handlers of client.ui.
export type Tab = "home" | "dms" | "more";

export type TabBarState = {
  mobileNav: Tab | null;
  profileRoute: boolean;
  settingsRoute: boolean;
  channelsRoute: boolean;
  invitationsRoute: boolean;
  ircRoute: boolean;
  agentsRoute: boolean;
  adminRoute: boolean;
};

// The More tab also covers the pages it opens, so it stays lit while one of them is showing.
export function tabIsActive(tab: Tab, ui: TabBarState): boolean {
  if (tab !== "more") return ui.mobileNav === tab;
  return ui.mobileNav === "more" || ui.profileRoute || ui.settingsRoute || ui.channelsRoute
    || ui.invitationsRoute || ui.ircRoute || ui.agentsRoute || ui.adminRoute;
}

type TabBarScope = TabBarState & { openHome(): void; openDms(): void; openMore(): void };

export function tabBarComponent() {
  return {
    isActive(this: TabBarScope, tab: Tab): boolean {
      return tabIsActive(tab, this);
    },
    select(this: TabBarScope, tab: Tab): void {
      if (tab === "home") this.openHome();
      else if (tab === "dms") this.openDms();
      else this.openMore();
    },
  };
}

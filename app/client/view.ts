// Which screen the shell shows. One place for the route chain the partials and the runtime used to
// repeat. `view` is a plain object of getters over the reactive client state, so a template reads
// `view.showsComposer` and re-runs when any flag it touched changes.
export type ViewState = {
  authenticated: boolean;
  booting: boolean;
  isDesktop: boolean;
  mobileNav: "home" | "dms" | "more" | null;
  peekRoom: string;
  joinRoute: boolean;
  admissionRoute: boolean;
  profileRoute: boolean;
  settingsRoute: boolean;
  channelsRoute: boolean;
  invitationsRoute: boolean;
  ircRoute: boolean;
  agentsRoute: boolean;
  adminRoute: boolean;
  library: { on: boolean };
  activeChannelArchived(): boolean;
};

export type PageName = "admin" | "agents" | "channels" | "invitations" | "settings" | "irc" | "profile";

const TITLES: Record<PageName, string> = {
  admin: "Admin", agents: "Agents", channels: "Create channel", invitations: "People", settings: "Devices", irc: "IRC clients", profile: "You",
};
const ICONS: Record<PageName, string> = {
  admin: "user-star", agents: "bot", channels: "hash", invitations: "mail", settings: "smartphone", irc: "terminal", profile: "user",
};

export function createView(ui: ViewState) {
  return {
    // One of the seven pages opened from More (or the desktop account menu).
    get onPage(): boolean {
      return ui.profileRoute || ui.settingsRoute || ui.channelsRoute || ui.invitationsRoute || ui.ircRoute || ui.agentsRoute || ui.adminRoute;
    },
    // Any route that replaces the conversation, including join and admission.
    get routed(): boolean {
      return this.onPage || ui.joinRoute || ui.admissionRoute;
    },
    get isProfile(): boolean { return ui.profileRoute; },
    get isSettings(): boolean { return ui.settingsRoute; },
    // The page showing, in the order the header has always checked them; null on a conversation.
    get page(): PageName | null {
      if (ui.adminRoute) return "admin";
      if (ui.agentsRoute) return "agents";
      if (ui.channelsRoute) return "channels";
      if (ui.invitationsRoute) return "invitations";
      if (ui.settingsRoute) return "settings";
      if (ui.ircRoute) return "irc";
      if (ui.profileRoute || this.onPage) return "profile";
      return null;
    },
    get pageTitle(): string { return TITLES[this.page ?? "profile"]; },
    get pageIcon(): string { return ICONS[this.page ?? "profile"]; },
    // The conversation is the screen: no page on top and, on a phone, no tab screen.
    get inConversation(): boolean {
      return !this.onPage && (ui.isDesktop || ui.mobileNav === null);
    },
    get showsHeader(): boolean {
      return !ui.booting && (ui.authenticated || !!ui.peekRoom) && !ui.joinRoute && (ui.isDesktop || (ui.mobileNav === null && !this.onPage));
    },
    get showsRoomTitle(): boolean { return !this.onPage; },
    get showsTranscript(): boolean {
      return (ui.authenticated || !!ui.peekRoom) && this.inConversation && !ui.library.on;
    },
    get showsArchivedNotice(): boolean {
      return ui.authenticated && ui.activeChannelArchived() && this.inConversation && !ui.library.on;
    },
    get showsComposer(): boolean {
      return ui.authenticated && this.inConversation && !ui.library.on && !ui.activeChannelArchived();
    },
    // Toasts sit above the composer on a conversation and at the bottom edge everywhere else.
    get composerSpace(): boolean {
      return ui.authenticated && this.inConversation;
    },
    // The phone tab bar: tab roots and More pages, never a conversation.
    get showsTabBar(): boolean {
      return !!ui.mobileNav || this.onPage;
    },
  };
}

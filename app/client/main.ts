// Browser entrypoint. Protocol, durable state and feature UI are wired in runtime.ts.
import { createClient } from "@client/runtime.ts";
import { landOffer } from "@client/phone-offer.ts";
import { tooltipDirective } from "@client/tooltips.ts";
import { codeDirective } from "@client/code-input.ts";
import { tabBarComponent } from "@client/tab-bar.ts";
import { helpDialogComponent, jumpDialogComponent, channelSearchDialogComponent } from "@client/palettes.ts";
import { slashHelpPanelComponent, mentionPickerComponent } from "@client/composer-pickers.ts";
import { pullRefreshComponent } from "@client/pull-refresh.ts";

// Every Alpine directive and component. `() => client.x` hands every mount the same object, so each
// name may be mounted once in the shell and never inside a template.
export function registerComponents(Alpine: any, client: ReturnType<typeof createClient>): void {
  Alpine.directive("tooltip", tooltipDirective);
  Alpine.directive("code", codeDirective);
  Alpine.data("jumpDialog", jumpDialogComponent);
  Alpine.data("channelSearchDialog", channelSearchDialogComponent);
  Alpine.data("helpDialog", helpDialogComponent);
  Alpine.data("giphyPicker", () => client.giphy);
  Alpine.data("emojiPicker", () => client.emoji);
  Alpine.data("slashHelpPanel", () => slashHelpPanelComponent(client.openPopup));
  Alpine.data("mentionPicker", () => mentionPickerComponent(client.openPopup));
  Alpine.data("devicePairing", () => client.pairing);
  Alpine.data("signIn", () => client.signIn);
  Alpine.data("openPeek", () => client.peek);
  Alpine.data("transcript", () => client.transcript);
  Alpine.data("profilePage", () => client.profile);
  Alpine.data("tabBar", tabBarComponent);
  Alpine.data("settingsPage", () => client.settings);
  Alpine.data("channelsPage", () => client.channelCreate);
  Alpine.data("newConversation", () => client.newConversation);
  Alpine.data("invitationsPage", () => client.invitationsPage);
  Alpine.data("bulkInvite", () => client.bulkInvite);
  Alpine.data("invitationAccept", () => client.invitationAccept);
  Alpine.data("admission", () => client.admission);
  Alpine.data("admissionFounder", () => client.admissionFounder);
  Alpine.data("ircPage", () => client.irc);
  Alpine.data("agentsPage", () => client.agents);
  Alpine.data("adminPage", () => client.adminStatus);
  Alpine.data("membersPanel", () => client.members);
  Alpine.data("conversationMenu", () => client.menus);
  Alpine.data("channelSettings", () => client.channelPrefs);
  Alpine.data("directDelete", () => client.directDelete);
  Alpine.data("peopleCard", () => client.people);
  Alpine.data("mediaView", () => client.mediaView);
  Alpine.data("messageActions", () => client.actions);
  Alpine.data("composerEditor", () => client.editor);
  Alpine.data("linkActions", () => client.links);
  Alpine.data("pullRefresh", (target: "list" | "chat") => pullRefreshComponent(target, { refresh: client.pullRefresh, enabled: () => client.ui.authenticated && !client.ui.isDesktop }));
  Alpine.data("client", () => client.ui);
}

async function start(): Promise<void> {
  // A scanned pairing link (/pair#o=…): take the token out of the address bar and spend it before
  // the client reads the route or asks who is signed in.
  const pairFailure = await landOffer(location, history);
  const Alpine: any = (await import("../public/vendor/alpine.js")).default;
  const client = createClient(Alpine);
  registerComponents(Alpine, client);
  Alpine.start();
  await client.connect();
  // connect() resets account UI when nobody is signed in, so the reason goes on the sign-in card after it.
  if (pairFailure && !client.ui.authenticated) client.ui.error = pairFailure;
}

if (typeof document !== "undefined" && document.querySelector("[data-client-root]")) void start();

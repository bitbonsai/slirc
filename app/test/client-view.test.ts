// The view getters decide which screen the shell shows from the route flags.
import { expect, test } from "bun:test";
import { createView, type ViewState } from "@client/view.ts";

const pages = ["profileRoute", "settingsRoute", "channelsRoute", "invitationsRoute", "ircRoute", "agentsRoute", "adminRoute"] as const;

function state(over: Partial<ViewState> = {}): ViewState {
  return {
    authenticated: true, booting: false, isDesktop: true, mobileNav: null, peekRoom: "", joinRoute: false, admissionRoute: false,
    profileRoute: false, settingsRoute: false, channelsRoute: false, invitationsRoute: false, ircRoute: false, agentsRoute: false, adminRoute: false,
    library: { on: false }, activeChannelArchived: () => false, ...over,
  };
}

test("a conversation shows its transcript and composer", () => {
  const view = createView(state());
  expect([view.showsTranscript, view.showsComposer, view.showsHeader, view.composerSpace]).toEqual([true, true, true, true]);
});

test("every page replaces the conversation but keeps the header on desktop", () => {
  for (const route of pages) {
    const view = createView(state({ [route]: true }));
    expect(view.onPage, route).toBe(true);
    expect([view.showsTranscript, view.showsComposer, view.showsRoomTitle], route).toEqual([false, false, false]);
    expect(view.showsHeader, route).toBe(true);
  }
});

test("on a phone a page or tab screen hides the conversation and the header", () => {
  for (const over of [{ mobileNav: "home" as const }, { settingsRoute: true }]) {
    const view = createView(state({ isDesktop: false, ...over }));
    expect([view.showsTranscript, view.showsComposer, view.showsHeader, view.showsTabBar]).toEqual([false, false, false, true]);
  }
  expect(createView(state({ isDesktop: false })).showsTabBar).toBe(false);
});

test("the links library and an archived channel take the composer away", () => {
  expect(createView(state({ library: { on: true } })).showsTranscript).toBe(false);
  const archived = createView(state({ activeChannelArchived: () => true }));
  expect([archived.showsComposer, archived.showsArchivedNotice, archived.showsTranscript]).toEqual([false, true, true]);
});

test("a signed-out peek shows the transcript but never the composer", () => {
  const view = createView(state({ authenticated: false, peekRoom: "open-chat" }));
  expect([view.showsTranscript, view.showsHeader, view.showsComposer]).toEqual([true, true, false]);
  expect(createView(state({ joinRoute: true })).showsHeader).toBe(false);
});

test("the header names the page showing", () => {
  expect(createView(state({ settingsRoute: true })).pageTitle).toBe("Devices");
  expect(createView(state({ adminRoute: true })).pageTitle).toBe("Admin");
  expect(createView(state({ profileRoute: true })).pageIcon).toBe("user");
  expect(createView(state({ ircRoute: true })).isSettings).toBe(false);
  expect(createView(state({ settingsRoute: true })).isSettings).toBe(true);
});

test("join and admission count as routed without being pages", () => {
  const view = createView(state({ admissionRoute: true }));
  expect([view.routed, view.onPage]).toEqual([true, false]);
});

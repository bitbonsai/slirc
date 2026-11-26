import { expect, test } from "bun:test";
import { createClientState } from "../client/client-state.ts";

test("header direct-message state exists before authentication or room selection", () => {
  for (const [desktop, coarse] of [[true, false], [false, true]]) {
    const state = createClientState(desktop, coarse);
    expect(state.authenticated).toBe(false);
    expect(state.currentConversationId).toBeNull();
    expect(Object.hasOwn(state, "direct")).toBe(true);
    expect(state.direct).toBe(false);
  }
});

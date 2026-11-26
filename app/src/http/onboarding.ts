import { enabledHelpers } from "../config.ts";
import { needsOnboarding, queueOnboarding } from "../onboarding.ts";
import { openDirectConversation } from "../direct.ts";
import { publish } from "../live.ts";

// First verified sign-in: the help bot opens a DM with the tour. Returns whether the DM channel was
// really provisioned, so a signed-in person can be sent there; a disabled or failed helper never
// fakes that and never blocks the login. The "direct" event lets a tab that loaded before the DM
// existed pick it up, with its unread welcome, without a reload.
export async function sendOnboarding(nick: string): Promise<boolean> {
  if (!enabledHelpers().includes("help") || !needsOnboarding(nick)) return false;
  try {
    const direct = await openDirectConversation(nick, "help");
    queueOnboarding(nick, direct.channel);
    publish(nick, "direct", { channel: direct.channel });
    return true;
  } catch (error) {
    console.error(`onboarding DM failed for ${nick}:`, error);
    return false;
  }
}

// A ready-to-provision binding for tests that need an allowed session without walking the request
// and Allow routes. Import it with `await import` after any mock.module calls, like the app.
import { bindSession, hashAgentSecret, type Binding } from "../src/agent-session.ts";

export function testBinding(input: {
  owner: string; harness: string; protocol?: number; sessionId: string; sessionFile: string; secret: string;
  machine: string; sessionName: string; repo?: string; model?: string; provider?: string; ownerAccountIdForNick: (nick: string) => string | null;
}): { binding: Binding } {
  const ownerAccountId = input.ownerAccountIdForNick(input.owner);
  if (!ownerAccountId) throw new Error(`no account for ${input.owner}`);
  return { binding: bindSession({ ...input, ownerAccountId, secretHash: hashAgentSecret(input.secret) }) };
}

import { type ClientSession, type ClientState } from "@client/client-state.ts";
import { type Message } from "@client/model.ts";
import { isDailyGreeting } from "../shared/service-bots.ts";

// One-time note under the first daily G'day a person sees, in the inline add-prompt style: Turn off
// sets the per-account greeting setting, Keep just closes it. "Seen" is stored with the setting on
// the server the moment the note first shows, so no other device offers it again.
export function createGreetingNote(reactive: <T extends object>(value: T) => T, { core, session }: {
  core: Pick<ClientState, "greeting" | "greetingNoteSeen">;
  session: ClientSession;
}) {
  const local = reactive({
    messageId: null as string | null,
    conversationId: null as string | null,
    state: "ask" as "ask" | "busy" | "done",
    text: "",
  });
  let key: string | null = null;
  const current = () => key !== null && session.key() === key && !session.stopped() && !session.signingOut();

  async function save(accountId: string, body: Record<string, boolean>): Promise<boolean> {
    try {
      const response = await fetch("/profile", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, ...body }) });
      return response.ok;
    } catch { return false; }
  }

  // Called with the open conversation's rows each time they change.
  function consider(messages: readonly Message[]): void {
    const scope = session.scope();
    if (!scope || core.greetingNoteSeen || !core.greeting || (local.messageId && current())) return;
    const greeting = messages.findLast((message) => message.state === "confirmed" && isDailyGreeting(message.authorAccount, message.text));
    if (!greeting) return;
    key = session.key();
    Object.assign(local, { messageId: greeting.id, conversationId: greeting.conversationId, state: "ask", text: "Daily greeting from welcome." });
    core.greetingNoteSeen = true;
    void save(scope.accountId, { greetingNoteSeen: true });
  }

  function forMessage(messageId: string): boolean {
    return current() && local.messageId === messageId && local.state !== "done";
  }

  // Turning the greeting off hides the row the note sat under, so the outcome shows at the end.
  function atEnd(conversationId: string | null): boolean {
    return current() && !!local.messageId && local.conversationId === conversationId && local.state === "done";
  }

  async function turnOff(): Promise<void> {
    const scope = session.scope();
    if (!scope || !current() || local.state !== "ask") return;
    local.state = "busy";
    const ok = await save(scope.accountId, { greeting: false, greetingNoteSeen: true });
    if (!current()) return;
    if (ok) { core.greeting = false; Object.assign(local, { state: "done", text: "Turned off. Change it in Settings." }); }
    else Object.assign(local, { state: "ask", text: "Couldn't turn it off. Try again." });
  }

  function dismiss(): void {
    if (local.state === "busy") return;
    Object.assign(local, { messageId: null, conversationId: null, state: "ask", text: "" });
  }

  return Object.assign(local, { consider, forMessage, atEnd, turnOff, dismiss, reset: dismiss, destroy: dismiss });
}

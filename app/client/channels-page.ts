import { type ClientSession, type ClientState } from "@client/client-state.ts";

// Create-channel form. The page only collects input; provisioning stays on the server
// (`POST /api/channels` real Ergo membership + modes + metadata). After a 201 the socket is
// revalidated so the new room joins, then the room opens through the normal authorized path.
export function createChannelsPage(reactive: <T extends object>(value: T) => T, { core, session, connect, openRoom }: {
  core: Pick<ClientState, "authenticated" | "account">;
  session: ClientSession;
  connect: () => Promise<void>;
  openRoom: (room: string) => void;
}) {
  let epoch = 0;
  const local = reactive({
    newChannel: "",
    channelVisibility: "secret" as "secret" | "workspace",
    channelBusy: false,
    channelError: "",
  });

  function scope() {
    const current = session.scope();
    if (!current || !core.authenticated || current.account !== core.account || session.stopped() || session.signingOut()) return null;
    const key = session.key(), revision = epoch;
    return {
      current: () => epoch === revision && session.key() === key && session.scope()?.account === current.account
        && core.authenticated && core.account === current.account && !session.stopped() && !session.signingOut(),
    };
  }

  async function createChannel(): Promise<void> {
    const owner = scope();
    if (!owner || local.channelBusy || !local.newChannel.trim()) return;
    local.channelBusy = true; local.channelError = "";
    try {
      const response = await fetch("/api/channels", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: local.newChannel.trim(), visibility: local.channelVisibility }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not create channel.");
      if (!owner.current()) return;
      local.newChannel = "";
      // Re-read server access so the new room is authorized before we route to it.
      await connect();
      if (!owner.current() || typeof result.channel !== "string") return;
      openRoom(result.channel);
    } catch (error) {
      if (owner.current()) local.channelError = error instanceof Error ? error.message : "Could not create channel.";
    } finally { if (owner.current()) local.channelBusy = false; }
  }

  function reset(): void { epoch += 1; local.newChannel = ""; local.channelVisibility = "secret"; local.channelBusy = false; local.channelError = ""; }

  return Object.assign(local, { createChannel, reset, destroy: reset });
}

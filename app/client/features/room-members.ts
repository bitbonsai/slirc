import { conversationId } from "@client/model.ts";
import type { AuthorizedConversation } from "@client/sync.ts";
import { rememberAvatarVersions } from "@client/presentation.ts";
import { memberResponseApplies, type createMembersPanel } from "@client/members-panel.ts";
import { mergeAgents } from "@client/agent-roster.ts";
import type { createPresence } from "@client/presence.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface RoomMembersDeps {
  state: Pick<RuntimeState, "currentScope" | "directories" | "roomId" | "stopped">;
  ui: Pick<ClientState, "agentProfiles" | "avatarVersions" | "contacts" | "directs" | "roomMemberRows" | "roomMembers" | "roomMembersError" | "roomMembersLoading" | "roomMembersOwner" | "roomMembersPublic" | "roomPendingInvitations">;
  members: () => ReturnType<typeof createMembersPanel>;
  presence: () => ReturnType<typeof createPresence>;
}

export function createRoomMembers(deps: RoomMembersDeps) {
  const { state: rs, ui, members, presence } = deps;

  // Bumped on every clear/navigation/account change; an in-flight member reply older than the current
  // generation is dropped so it cannot repopulate the rail after a disconnect or revoke.
  let memberEpoch = 0;

  function clearRoomMembers(): void {
    memberEpoch += 1;
    ui.roomMemberRows = []; ui.roomPendingInvitations = []; ui.roomMembers = []; ui.roomMembersOwner = "";
    ui.roomMembersPublic = false; ui.roomMembersLoading = false; ui.roomMembersError = "";
  }

  function loadRoomMembers(item: AuthorizedConversation | undefined, id: string | null): void {
    // No account scope yet (pre-connect reactivity): never fetch into an unauthenticated window.
    if (!rs.currentScope) { clearRoomMembers(); refreshPresence(); return; }
    if (!item || item.kind !== "room") { clearRoomMembers(); refreshPresence(); return; }
    const wire = item.wireTarget;
    const requestingScope = rs.currentScope;
    clearRoomMembers();
    const requestEpoch = memberEpoch;
    ui.roomMembersLoading = true;
    refreshPresence();
    void fetch(`/api/channels/${encodeURIComponent(wire)}/members`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) })
      .then(async (response) => ({ ok: response.ok, status: response.status, body: await response.json().catch(() => null) }))
      .then(({ ok, status, body }) => {
        if (!memberResponseApplies(
          { conversationId: id, scope: requestingScope, generation: requestEpoch },
          { conversationId: rs.roomId, scope: rs.currentScope, generation: memberEpoch, stopped: rs.stopped, authorized: !!rs.roomId && rs.directories.has(rs.roomId) },
        )) return;
        if (!ok) throw new Error(typeof body?.error === "string" ? body.error : `Could not load members (${status}).`);
        const rows: unknown[] = Array.isArray(body?.members) ? body.members : [];
        ui.roomMembersPublic = body?.public === true;
        ui.roomMembersOwner = typeof body?.owner === "string" ? body.owner : "";
        ui.roomPendingInvitations = Array.isArray(body?.pendingInvitations)
          ? body.pendingInvitations.filter((row: any) => row && typeof row.email === "string" && ["pending", "sending", "uncertain"].includes(row.status)) : [];
        ui.roomMemberRows = rows.filter((row): row is Record<string, unknown> => !!row && typeof (row as Record<string, unknown>).nick === "string")
          .map((row) => ({
            nick: String(row.nick),
            kind: typeof row.kind === "string" ? row.kind : "member",
            role: typeof row.role === "string" ? row.role : "member",
            machine: typeof row.machine === "string" ? row.machine : null,
            availability: typeof row.availability === "string" ? row.availability : "",
            badge: typeof row.badge === "string" ? row.badge : "",
          }));
        ui.roomMembers = ui.roomMemberRows.map((row) => row.nick);
        rememberAvatarVersions(ui.avatarVersions, rows);
        presence().setAvailability(rows as { nick: string; availability?: unknown; badge?: unknown; attached?: unknown }[]);
        ui.agentProfiles = mergeAgents(ui.agentProfiles, rows);
        ui.roomMembersLoading = false;
        refreshPresence();
      })
      .catch((error) => {
        if (!memberResponseApplies(
          { conversationId: id, scope: requestingScope, generation: requestEpoch },
          { conversationId: rs.roomId, scope: rs.currentScope, generation: memberEpoch, stopped: rs.stopped, authorized: !!rs.roomId && rs.directories.has(rs.roomId) },
        )) return;
        ui.roomMembersLoading = false;
        ui.roomMembersError = error instanceof Error && error.name === "TimeoutError" ? "Members took too long to load." : error instanceof Error ? error.message : "Could not load members.";
        ui.roomMemberRows = []; ui.roomPendingInvitations = []; ui.roomMembers = []; refreshPresence();
      });
  }

  function refreshPresence(): void {
    presence().watch([...ui.directs.map((item: { nick: string }) => item.nick), ...ui.contacts, ...ui.roomMembers]);
  }

  return { clearRoomMembers, loadRoomMembers, refreshPresence };
}

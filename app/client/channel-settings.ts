import { type ClientSession, type ClientState } from "@client/client-state.ts";

type Visibility = "" | "open" | "secret";

// Channel settings: visibility and topic share one Save that sends only what changed. Admins also
// get a delete section; deleting asks for the channel name typed back before it goes.
export function createChannelSettings(reactive: <T extends object>(value: T) => T, { core, nextTick, closeMenu, session, onDeleted = () => {} }: {
  core: Pick<ClientState, 'channelDetails' | 'account' | 'isAdmin' | 'defaultChannel' | 'openRooms'>;
  nextTick: (callback?: () => void) => Promise<void>;
  closeMenu: () => void;
  session: ClientSession;
  onDeleted?: (channel: string) => void;
}) {
  let revision = 0;
  let invoker: HTMLElement | null = null;
  const local = reactive({
    channelSettings: "",
    channelTopicDraft: "",
    channelTopicSaved: "",
    channelVisibility: "" as Visibility,
    channelVisibilitySaved: "" as Visibility,
    channelIsGroup: false,
    channelSettingsBusy: false,
    channelSettingsError: "",
    channelDeleteOpen: false,
    channelDeleteName: "",
    channelDeleteBusy: false,
    channelDeleteError: "",
    channelArchiveOpen: false,
    channelArchiveBusy: false,
    channelArchiveError: "",
  });
  const dialog = () => document.querySelector<HTMLDialogElement>("#channel-settings-dialog");
  const path = (channel: string) => `/api/channels/${encodeURIComponent(channel.replace(/^#/, ""))}`;
  const visibilityOf = (value: string): Visibility => value === "workspace" ? "open" : value === "secret" ? "secret" : "";

  function resetDelete(): void {
    local.channelDeleteOpen = false; local.channelDeleteName = ""; local.channelDeleteBusy = false; local.channelDeleteError = "";
    local.channelArchiveOpen = false; local.channelArchiveBusy = false; local.channelArchiveError = "";
  }

  function openChannelSettings(target: string): void {
    const info = core.channelDetails.find((item) => item.channel === target);
    if (!info) return;
    revision += 1;
    const active = document.activeElement as HTMLElement | null | undefined;
    invoker = typeof active?.focus === "function" ? active : null;
    local.channelSettingsBusy = false;
    local.channelSettings = target;
    local.channelTopicDraft = info.topic; local.channelTopicSaved = info.topic;
    local.channelVisibility = visibilityOf(info.visibility); local.channelVisibilitySaved = local.channelVisibility;
    local.channelIsGroup = info.isGroup === true;
    local.channelSettingsError = "";
    resetDelete();
    closeMenu();
    void nextTick(() => dialog()?.showModal());
  }

  function closeChannelSettings(): void {
    if (local.channelDeleteBusy || local.channelArchiveBusy) return;
    if (dialog()?.open) dialog()!.close();
    revision += 1;
    local.channelSettings = ""; local.channelSettingsError = ""; local.channelSettingsBusy = false;
    local.channelVisibility = ""; local.channelVisibilitySaved = ""; local.channelIsGroup = false;
    resetDelete();
    if (invoker?.isConnected) invoker.focus();
    invoker = null;
  }

  function canManageVisibility(): boolean {
    const info = core.channelDetails.find((item) => item.channel === local.channelSettings);
    return !!info && (core.isAdmin || info.owner === core.account);
  }

  // The server refuses the same cases; hiding them here keeps the button honest.
  function canDeleteChannel(): boolean {
    const channel = local.channelSettings.toLowerCase();
    if (!core.isAdmin || !local.channelVisibilitySaved || local.channelIsGroup) return false;
    return channel !== core.defaultChannel && !core.openRooms[channel];
  }

  function channelArchived(): boolean {
    return core.channelDetails.find((item) => item.channel === local.channelSettings)?.archived === true;
  }

  // Owner or admin, on a real channel. DMs and threads never get it (the server refuses them too),
  // and the default and open channels stay writable because newcomers land there.
  function canArchiveChannel(): boolean {
    const info = core.channelDetails.find((item) => item.channel === local.channelSettings);
    const channel = local.channelSettings.toLowerCase();
    if (!info || info.visibility === "direct" || /^#(dm-|t-)/.test(channel)) return false;
    if (channel === core.defaultChannel || core.openRooms[channel]) return false;
    return core.isAdmin || info.owner === core.account;
  }

  // Archiving asks first; unarchiving is harmless and goes straight through.
  function askArchive(): void {
    if (!canArchiveChannel() || local.channelArchiveBusy) return;
    if (channelArchived()) { void setArchived(false); return; }
    local.channelArchiveOpen = true; local.channelArchiveError = "";
    void nextTick(() => document.querySelector<HTMLElement>("#channel-archive-confirm")?.focus());
  }

  function cancelArchive(): void {
    if (local.channelArchiveBusy) return;
    local.channelArchiveOpen = false; local.channelArchiveError = "";
    void nextTick(() => document.querySelector<HTMLElement>("#channel-archive-open")?.focus());
  }

  async function setArchived(archived: boolean): Promise<void> {
    const channel = local.channelSettings;
    if (!channel || local.channelArchiveBusy || !canArchiveChannel()) return;
    const ownerScope = session.key();
    const requestRevision = revision;
    const current = () => session.key() === ownerScope && revision === requestRevision && !session.stopped();
    local.channelArchiveBusy = true; local.channelArchiveError = "";
    try {
      const info = await patch(channel, { action: archived ? "archive" : "unarchive" });
      if (!current()) return;
      core.channelDetails = core.channelDetails.map((item) => item.channel === info.channel ? info : item);
      local.channelArchiveOpen = false;
      void nextTick(() => document.querySelector<HTMLElement>("#channel-archive-open")?.focus());
    } catch (error) {
      if (current()) local.channelArchiveError = error instanceof Error ? error.message : "Could not update the channel.";
    } finally { if (current()) local.channelArchiveBusy = false; }
  }

  function pickVisibility(target: "open" | "secret"): void {
    if (local.channelSettingsBusy || !canManageVisibility()) return;
    local.channelSettingsError = "";
    local.channelVisibility = target;
  }

  // Arrow keys move the choice, like a native radio group.
  function visibilityKey(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const group = event.currentTarget as HTMLElement | null;
    pickVisibility(local.channelVisibility === "open" ? "secret" : "open");
    void nextTick(() => group?.querySelector<HTMLElement>("[aria-checked='true']")?.focus());
  }

  function visibilityHint(): string {
    if (local.channelVisibility === "open") {
      return local.channelVisibilitySaved === "open"
        ? "Every verified member can find and join it, and read its history."
        : "Every verified member will be able to find and join it, and read its history.";
    }
    return "Only people who are invited can find and join it.";
  }

  function channelSettingsDirty(): boolean {
    return local.channelTopicDraft !== local.channelTopicSaved || local.channelVisibility !== local.channelVisibilitySaved;
  }

  async function patch(channel: string, body: Record<string, string>): Promise<any> {
    const response = await fetch(path(channel), { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, source: "app" }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not save the channel.");
    return result;
  }

  async function saveChannelSettings(): Promise<void> {
    const channel = local.channelSettings;
    if (!channel || local.channelSettingsBusy || !channelSettingsDirty()) return;
    const ownerScope = session.key();
    const requestRevision = revision;
    const current = () => session.key() === ownerScope && revision === requestRevision && !session.stopped();
    const apply = (info: any) => { core.channelDetails = core.channelDetails.map((item) => item.channel === info.channel ? info : item); };
    const visibility = local.channelVisibility;
    const topic = local.channelTopicDraft;
    local.channelSettingsBusy = true; local.channelSettingsError = "";
    try {
      if (visibility !== local.channelVisibilitySaved && (visibility === "open" || visibility === "secret")) {
        const info = await patch(channel, { action: visibility });
        if (!current()) return;
        apply(info);
        local.channelVisibilitySaved = visibilityOf(info.visibility);
      }
      if (topic !== local.channelTopicSaved) {
        const info = await patch(channel, { action: "topic", topic });
        if (!current()) return;
        apply(info);
        local.channelTopicSaved = topic;
      }
      local.channelSettingsBusy = false;
      closeChannelSettings();
    } catch (error) {
      if (current()) local.channelSettingsError = error instanceof Error ? error.message : "Could not save the channel.";
    } finally { if (current()) local.channelSettingsBusy = false; }
  }

  function askDelete(): void {
    if (!canDeleteChannel()) return;
    local.channelDeleteOpen = true; local.channelDeleteName = ""; local.channelDeleteError = "";
    void nextTick(() => document.querySelector<HTMLInputElement>("#channel-delete-name")?.focus());
  }

  function cancelDelete(): void {
    if (local.channelDeleteBusy) return;
    resetDelete();
    void nextTick(() => document.querySelector<HTMLElement>("#channel-delete-open")?.focus());
  }

  // Typed with or without the `#`, any case.
  function deleteNameMatches(): boolean {
    const typed = local.channelDeleteName.trim().replace(/^#/, "").toLowerCase();
    return !!typed && typed === local.channelSettings.replace(/^#/, "").toLowerCase();
  }

  async function deleteChannel(): Promise<void> {
    const channel = local.channelSettings;
    if (!channel || local.channelDeleteBusy || !deleteNameMatches()) return;
    const ownerScope = session.key();
    local.channelDeleteBusy = true; local.channelDeleteError = "";
    try {
      const response = await fetch(path(channel), { method: "DELETE", credentials: "same-origin" });
      const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error || "Could not delete the channel.");
      if (session.key() !== ownerScope || session.stopped()) return;
      local.channelDeleteBusy = false;
      invoker = null;
      closeChannelSettings();
      onDeleted(channel);
    } catch (error) {
      if (session.key() === ownerScope) local.channelDeleteError = error instanceof Error ? error.message : "Could not delete the channel.";
    } finally { if (session.key() === ownerScope) local.channelDeleteBusy = false; }
  }

  return Object.assign(local, {
    openChannelSettings,
    closeChannelSettings,
    saveChannelSettings,
    channelSettingsDirty,
    canManageVisibility,
    canDeleteChannel,
    channelArchived,
    canArchiveChannel,
    askArchive,
    cancelArchive,
    setArchived,
    pickVisibility,
    visibilityKey,
    visibilityHint,
    askDelete,
    cancelDelete,
    deleteNameMatches,
    deleteChannel,
    destroy: closeChannelSettings,
  });
}

import { prepareProfilePhoto, profileFields, reconcileProfileFields, sameProfileFields } from "@client/profile.ts";
import { placePopup, visualViewportRect } from "@client/popups.ts";
import { normalizeProfileBadge, profileBadgeOptions } from "../shared/profile-badges.ts";
import { type ClientSession, type ClientState } from "@client/client-state.ts";

export function createProfilePage(reactive: <T extends object>(value: T) => T, { core, nextTick, session, welcome, setName }: {
  core: Pick<ClientState, 'account' | 'authenticated'>;
  nextTick: (callback?: () => void) => Promise<void>;
  session: ClientSession;
  // Founder-only welcome control. Rendered from its own reactive state; a non-founder never sees it.
  welcome: { state: { available: boolean; enabled: boolean; busy: boolean; note: string; pending: number }; load(): Promise<void>; setEnabled(enabled: boolean): Promise<void>; reset(): void };
  setName: (name: string) => void;
}) {
  let profileRevision = 0;
  let avatarEpoch = 0;
  let badgeEpoch = 0;
  const local = reactive({
    profileForm: profileFields(null),
    profileSaved: profileFields(null),
    memberSince: null as number | null,
    profileEmail: "",
    profileSaving: false,
    profileNote: "",
    profileError: "",
    badgeSaving: false,
    badgeError: "",
    avatarBusy: false,
    avatarError: "",
    avatarNote: "",
    avatarVersion: Date.now(),
  });

  function applyProfile(profile: unknown): void {
    const next = reconcileProfileFields(profileFields(local.profileForm), profileFields(local.profileSaved), profileFields(profile));
    local.profileForm = next.form;
    local.profileSaved = next.saved;
    const read = (profile ?? {}) as { memberSince?: unknown; email?: unknown };
    local.memberSince = Number.isFinite(read.memberSince) ? read.memberSince as number : null;
    local.profileEmail = typeof read.email === "string" ? read.email : "";
    setName(next.saved.fullName || core.account);
  }

  function closeBadgePicker(): void {
    const picker = globalThis.document?.getElementById?.("profile-badge-picker");
    if (picker?.matches(":popover-open")) picker.hidePopover();
  }

  function badgePickerToggled(event: ToggleEvent): void {
    if (event.newState !== "open") return;
    const picker = event.currentTarget as HTMLElement;
    const trigger = document.getElementById("profile-badge-trigger");
    if (!trigger) return;
    picker.style.maxHeight = "";
    const placement = placePopup(trigger.getBoundingClientRect(), picker.getBoundingClientRect(), visualViewportRect());
    picker.style.top = `${placement.top}px`;
    picker.style.left = `${placement.left}px`;
    picker.style.maxHeight = placement.maxHeight === undefined ? "" : `${placement.maxHeight}px`;
    picker.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }

  async function chooseBadge(value: unknown): Promise<void> {
    const badge = normalizeProfileBadge(value);
    const scope = session.scope();
    if (!badge || local.profileSaving || !core.authenticated || !scope || session.stopped() || session.signingOut()) return;
    local.profileForm.badge = badge;
    local.badgeError = "";
    closeBadgePicker();
    if (local.badgeSaving || badge === local.profileSaved.badge) return;
    const ownerScope = session.key();
    const epoch = ++badgeEpoch;
    const current = () => epoch === badgeEpoch && session.key() === ownerScope && core.authenticated && !session.stopped() && !session.signingOut();
    local.badgeSaving = true;
    profileRevision += 1;
    try {
      // Serialize rapid choices; each write touches only badge, never unsaved profile text.
      while (current()) {
        const submitted = local.profileForm.badge;
        try {
          const response = await fetch("/profile", {
            method: "PATCH", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ badge: submitted, accountId: scope.accountId }),
          });
          const body = await response.json().catch(() => ({}));
          if (!current()) return;
          if (!response.ok) throw new Error(body.error || "Could not save status. Try again.");
          local.profileSaved.badge = profileFields(body).badge;
        } catch (error) {
          if (!current()) return;
          if (local.profileForm.badge !== submitted) continue;
          local.profileForm.badge = local.profileSaved.badge;
          local.badgeError = error instanceof Error ? error.message : "Could not save status. Try again.";
          return;
        }
        profileRevision += 1;
        if (local.profileForm.badge === submitted) return;
      }
    } finally {
      if (epoch === badgeEpoch) { local.badgeSaving = false; profileRevision += 1; }
    }
  }

  function resetProfile(): void {
    closeBadgePicker();
    badgeEpoch += 1;
    local.badgeSaving = false;
    local.badgeError = "";
    profileRevision += 1;
    local.profileForm = profileFields(null);
    local.profileSaved = profileFields(null);
    local.memberSince = null;
    local.profileEmail = "";
    local.profileSaving = false;
    local.profileNote = ""; local.profileError = "";
    avatarEpoch += 1;
    local.avatarBusy = false;
    local.avatarError = "";
    local.avatarNote = "";
    local.avatarVersion = Date.now();
  }

  async function uploadAvatar(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // Choosing the same file again after a failure must fire change.
    const scope = session.scope();
    if (!file || local.avatarBusy || !core.authenticated || !scope) return;
    const ownerScope = session.key();
    const accountId = scope.accountId;
    const epoch = ++avatarEpoch;
    const current = () => epoch === avatarEpoch && session.key() === ownerScope && core.authenticated && !session.stopped() && !session.signingOut();
    local.avatarBusy = true; local.avatarError = ""; local.avatarNote = "";
    try {
      const photo = await prepareProfilePhoto(file);
      if (!current()) return;
      const response = await fetch("/profile/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ...photo, accountId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok) throw new Error(body.error || `Could not upload photo (${response.status}).`);
      local.avatarVersion = Math.max(Date.now(), local.avatarVersion + 1);
      local.avatarNote = "Photo updated.";
      // Do not apply the returned profile fields: an upload must not replace unsaved text edits.
    } catch (error) {
      if (current()) local.avatarError = error instanceof Error ? error.message : "Could not upload photo. Try again.";
    } finally {
      if (epoch === avatarEpoch) local.avatarBusy = false;
    }
  }

  function profileDirty(): boolean {
    return !sameProfileFields(local.profileForm, local.profileSaved);
  }

  async function saveProfile(): Promise<void> {
    if (local.profileSaving || local.badgeSaving || !profileDirty()) return;
    const ownerScope = session.key();
    // Snapshot the exact values being sent; edits made while the request is in flight keep their text.
    const submitted = profileFields(local.profileForm);
    profileRevision += 1;
    local.profileSaving = true; local.profileNote = ""; local.profileError = "";
    try {
      const response = await fetch("/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(submitted),
      });
      const body = await response.json().catch(() => ({}));
      if (session.stopped() || !core.authenticated || session.key() !== ownerScope) return;
      if (!response.ok) throw new Error((body as { error?: string }).error || `Could not save (${response.status}).`);
      profileRevision += 1;
      const next = reconcileProfileFields(profileFields(local.profileForm), submitted, profileFields(body));
      local.profileForm = next.form;
      local.profileSaved = next.saved;
      setName(next.saved.fullName || core.account);
      local.profileNote = "Profile saved.";
    } catch (error) {
      if (!session.stopped() && session.key() === ownerScope) local.profileError = error instanceof Error ? error.message : "Could not save profile.";
    } finally {
      if (session.key() === ownerScope) local.profileSaving = false;
    }
  }

  return Object.assign(local, {
    welcome,
    applyProfile,
    resetProfile,
    uploadAvatar,
    profileDirty,
    saveProfile,
    badgeOptions: profileBadgeOptions,
    badgeOption: () => profileBadgeOptions.find((option) => option.value === local.profileForm.badge) || profileBadgeOptions[0],
    chooseBadge,
    closeBadgePicker,
    badgePickerToggled,
    memberSinceLabel: () => local.memberSince ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(local.memberSince)) : "",
    revision: () => profileRevision,
    destroy: resetProfile,
  });
}

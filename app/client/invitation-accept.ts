import { type ClientSession } from "@client/client-state.ts";

// Invitation landing/acceptance. The token lives in the route (`/join/:token`) so signup, email
// verification and the zero-conversation bootstrap all return to the same screen. The browser never
// supplies an email: the server derives the recipient from the token. Acceptance is a real server
// call before any navigation, and the client refreshes its authorized mapping first.
export interface JoinInfo {
  destination?: { type?: string; channel?: string | null };
  requiresVerifiedEmail?: boolean;
  channel?: string;
}
export interface JoinResult { type?: string; channel?: string; nick?: string; accepted?: boolean }

export function joinDestinationLabel(info: JoinInfo | null): string {
  if (!info) return "this conversation";
  if (info.requiresVerifiedEmail) {
    if (info.destination?.type === "dm") return "a private conversation";
    return info.destination?.channel || "a private conversation";
  }
  return info.channel || "this channel";
}

export function createInvitationAccept(reactive: <T extends object>(value: T) => T, { session, connect, openDirect, openRoom, goHome, logout, authenticatedAccountId, destinationReachable }: {
  session: ClientSession;
  connect: () => Promise<void>;
  openDirect: (nick: string) => void | Promise<void>;
  openRoom: (room: string) => void;
  goHome: () => void;
  logout: () => Promise<void> | void;
  authenticatedAccountId: () => string;
  destinationReachable: (result: JoinResult) => boolean;
}) {
  const local = reactive({
    token: "",
    info: null as JoinInfo | null,
    loading: false,
    error: "",
    name: "",
    busy: false,
    signupBusy: false,
    signupSent: false,
    devLink: "",
    code: "",
    codeBusy: false,
    codeError: "",
    acceptError: "",
    accountMismatch: false,
  });

  // The join-info fetch is public, so it uses a token epoch rather than the account scope. The
  // account scope can open while the fetch is in flight (zero-conversation bootstrap).
  let infoSeq = 0;
  let acceptSeq = 0;
  let signupSeq = 0;
  let codeSeq = 0;

  function reset(): void {
    infoSeq += 1; acceptSeq += 1; signupSeq += 1; codeSeq += 1;
    local.token = ""; local.info = null; local.loading = false; local.error = "";
    local.name = ""; local.busy = false; local.signupBusy = false; local.signupSent = false;
    local.devLink = ""; local.acceptError = ""; local.accountMismatch = false;
    local.code = ""; local.codeBusy = false; local.codeError = "";
  }

  function isEmailInvite(): boolean { return local.info?.requiresVerifiedEmail === true; }
  // One busy flag for the whole join: a new address (or a typed code) signs in, connects, then
  // accepts, and the button spins through all of it instead of looking idle between the steps.
  function working(): boolean { return local.signupBusy || local.codeBusy || local.busy; }
  function destinationLabel(): string { return joinDestinationLabel(local.info); }

  async function start(token: string): Promise<void> {
    if (!token || (local.token === token && (local.info || local.loading))) return;
    const seq = ++infoSeq;
    // A signup or code answer still in flight belongs to the previous token: drop it.
    signupSeq += 1; codeSeq += 1;
    local.signupBusy = false; local.codeBusy = false;
    local.token = token;
    local.info = null; local.error = ""; local.acceptError = ""; local.accountMismatch = false;
    local.signupSent = false; local.devLink = "";
    local.code = ""; local.codeError = "";
    local.loading = true;
    try {
      const response = await fetch(`/api/join/${encodeURIComponent(token)}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (seq !== infoSeq || local.token !== token) return;
      if (!response.ok) throw new Error(body.error || "This invite link is not valid.");
      local.info = body as JoinInfo;
    } catch (error) {
      if (seq === infoSeq && local.token === token) local.error = error instanceof Error ? error.message : "Could not load this invite.";
    } finally {
      if (seq === infoSeq && local.token === token) local.loading = false;
    }
  }

  async function requestSignup(): Promise<void> {
    if (!isEmailInvite() || local.signupBusy || local.signupSent) return;
    const name = local.name.trim();
    if (!name) { local.acceptError = "Enter a display name."; return; }
    if (name.length > 80) { local.acceptError = "Names are limited to 80 characters."; return; }
    const seq = ++signupSeq;
    local.signupBusy = true; local.acceptError = "";
    try {
      // No email is ever sent from the browser: the server derives the recipient from the token.
      const response = await fetch("/auth/invitation/request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Invitation": "1" },
        body: JSON.stringify({ token: local.token, name }),
      });
      const body = await response.json().catch(() => ({}));
      if (seq !== signupSeq) return;
      if (!response.ok) throw new Error(body.error || "Could not join with this invitation.");
      // A new address is signed in on the spot: the link was mailed to it. Open the account scope,
      // then accept, so the person lands in the conversation without a second email.
      if (body.signedIn) {
        await connect();
        if (seq !== signupSeq) return;
        await accept();
        return;
      }
      // An address that already has an account gets a code and a sign-in link instead.
      local.signupSent = true;
      local.devLink = typeof body.devLink === "string" ? body.devLink : "";
    } catch (error) {
      if (seq === signupSeq) local.acceptError = error instanceof Error ? error.message : "Could not join with this invitation.";
    } finally {
      if (seq === signupSeq) local.signupBusy = false;
    }
  }

  // An address that already has an account is mailed a code with its sign-in link. The page still
  // sends only the token: the server finds the account, so the code works here without the email.
  function codeInput(): void {
    local.code = String(local.code || "").replace(/\D/g, "").slice(0, 6);
    local.codeError = "";
    if (local.code.length === 6) void submitCode();
  }
  async function submitCode(): Promise<void> {
    if (local.codeBusy || !local.signupSent) return;
    const code = String(local.code || "").replace(/\D/g, "");
    if (code.length !== 6) { local.codeError = "Enter the 6-digit code."; return; }
    const seq = ++codeSeq;
    local.codeBusy = true; local.codeError = "";
    try {
      const response = await fetch("/auth/code", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Invitation": "1" },
        body: JSON.stringify({ invitation: local.token, code }),
      });
      const body = await response.json().catch(() => ({}));
      if (seq !== codeSeq) return;
      if (!response.ok) throw new Error(body.error || "Could not check the code.");
      // Signed in. Same finish as a new address: open the account scope, then accept.
      // The code is spent, so a failure from here on is shown next to Join, not in the hidden form.
      local.signupSent = false; local.code = "";
      try { await connect(); } catch {
        if (seq === codeSeq) local.acceptError = "You are signed in, but we could not load your account. Reload to continue.";
        return;
      }
      if (seq !== codeSeq) return;
      await accept();
    } catch (error) {
      if (seq === codeSeq) { local.code = ""; local.codeError = error instanceof Error ? error.message : "Could not check the code."; }
    } finally {
      if (seq === codeSeq) local.codeBusy = false;
    }
  }

  async function accept(): Promise<void> {
    if (local.busy || !local.info) return;
    const authority = authenticatedAccountId();
    if (!authority) { local.acceptError = "Sign in to accept this invitation."; return; }
    const seq = ++acceptSeq;
    local.busy = true; local.acceptError = ""; local.accountMismatch = false;
    const sameAuthority = () => seq === acceptSeq && !session.stopped() && authenticatedAccountId() === authority;
    try {
      const response = await fetch(`/api/join/${encodeURIComponent(local.token)}`, { method: "POST", credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!sameAuthority()) return;
      if (!response.ok) {
        if (response.status === 403 && /verified invited email/i.test(String(body.error || ""))) local.accountMismatch = true;
        local.acceptError = body.error || "Could not accept this invitation.";
        return;
      }
      const result = body as JoinResult;
      // Refresh the authorized mapping before routing so the accepted room/DM is reachable. The
      // zero-conversation bootstrap opens the first real account scope here, so compare the
      // immutable account id, not the pre-refresh scope key.
      await connect();
      if (!sameAuthority()) return;
      if (!destinationReachable(result)) { local.acceptError = "The invitation was accepted, but the conversation is not available yet. Reload to continue."; return; }
      if (result.type === "direct" && result.nick) void openDirect(result.nick);
      else if (typeof result.channel === "string" && result.channel) openRoom(result.channel);
    } catch (error) {
      if (sameAuthority()) local.acceptError = error instanceof Error ? error.message : "Could not accept this invitation.";
    } finally {
      if (seq === acceptSeq) local.busy = false;
    }
  }

  function switchAccount(): void {
    local.acceptError = ""; local.accountMismatch = false;
    void logout();
  }

  return Object.assign(local, {
    start, reset, requestSignup, codeInput, submitCode, accept, switchAccount, isEmailInvite, destinationLabel, goHome, working,
    destroy: reset,
  });
}

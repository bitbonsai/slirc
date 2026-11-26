import { type ClientSession, type ClientState } from "@client/client-state.ts";

// Owner and newcomer halves of the admission flow. The newcomer screen never redeems, provisions a
// destination or authenticates merely by being opened: the capability stays in the URL fragment and
// an explicit name submission is the only redemption path. The owner half adds a review section to
// the Invitations page and never touches ordinary member invitations or its own state.
//
// Everything here is capability-blind in logs and errors: the token is passed only to the fixed
// same-origin endpoints, never rendered into an error string.

export interface AdmissionRedeemResult { admissionId: string; accountId: string; nick: string }
export interface AdmissionDestinationResult { type?: string; channel?: string; nick?: string }

export interface AdmissionApplication {
  id: string;
  email: string;
  selfhost?: boolean;
  createdAt?: number;
  revision?: number | string;
}
export interface Admission {
  id: string;
  applicationId: string;
  revision?: number | string;
  email?: string;
  expiresAt?: number;
  state: string;
  delivery: string;
  deliveryError?: string;
  createdAt?: number;
}
export interface AdmissionRow { application: AdmissionApplication; admission: Admission | null }

// A random >= 32-character base64url claim. Its only job is to keep an ambiguous retry bound to the
// same redemption attempt, so exact spelling does not matter as long as it is stable and opaque.
export function randomClaim(bytes = 24): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let raw = "";
  for (const byte of buffer) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Only the two fixed destinations exist. Any other value falls back to Help so the request can
// never ask the server for an arbitrary nick or channel.
export function normalizeDestination(value: unknown): "help" | "founder" {
  return value === "founder" ? "founder" : "help";
}

export function admissionRecordKey(token: string): string {
  return `slirc:admission:v1:${token}`;
}

const RESUME_KEY = "slirc:admission:v1:resume";

interface StoredAttempt {
  claim: string;
  name: string;
  redeemed?: AdmissionRedeemResult;
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch { return null; }
}

function storageAvailable(): boolean {
  const store = sessionStore();
  if (!store) return false;
  try {
    const probe = "slirc:admission:v1:probe";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return true;
  } catch { return false; }
}

function readAttempt(token: string): StoredAttempt | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    const raw = store.getItem(admissionRecordKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAttempt;
    if (!parsed || typeof parsed.claim !== "string" || typeof parsed.name !== "string") return null;
    return parsed;
  } catch { return null; }
}

function writeAttempt(token: string, value: StoredAttempt): boolean {
  const store = sessionStore();
  if (!store) return false;
  try { store.setItem(admissionRecordKey(token), JSON.stringify(value)); return true; } catch { return false; }
}

function forgetAttempt(token: string): void {
  const store = sessionStore();
  try { store?.removeItem(admissionRecordKey(token)); } catch { /* best effort */ }
}

// The explicit sign-in round trip leaves the page, so the fragment capability and its requested
// destination ride in sessionStorage until the redirected /admission load reads them back.
interface ResumeState { token: string; destination: "help" | "founder" }

function readResume(): ResumeState | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    const raw = store.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeState;
    if (!parsed || typeof parsed.token !== "string" || !parsed.token) return null;
    return { token: parsed.token, destination: normalizeDestination(parsed.destination) };
  } catch { return null; }
}

function clearResume(): void {
  const store = sessionStore();
  try { store?.removeItem(RESUME_KEY); } catch { /* best effort */ }
}

function admissionPost(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Slirc-Admission": "1" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Newcomer /admission screen
// ---------------------------------------------------------------------------

export interface AdmissionScreenDeps {
  core: Pick<ClientState, "authenticated" | "account" | "admissionSignIn">;
  session: ClientSession;
  connect: () => Promise<void>;
  openDirect: (nick: string) => void | Promise<void>;
  openRoom: (room: string) => void;
  goHome: () => void;
  logout: () => Promise<void> | void;
  authenticatedAccountId: () => string;
  destinationReachable: (result: AdmissionDestinationResult) => boolean;
}

export function createAdmissionScreen(reactive: <T extends object>(value: T) => T, deps: AdmissionScreenDeps) {
  const { core, session, connect, openDirect, openRoom, goHome, logout, authenticatedAccountId, destinationReachable } = deps;
  let seq = 0;
  let startedToken: string | null = null;

  const local = reactive({
    token: "",
    destination: "help" as "help" | "founder",
    started: false,
    error: "",
    name: "",
    claim: "",
    attempted: false,
    busy: false,
    redeemed: false,
    redeemedAccountId: "",
    redeemedNick: "",
    destinationBusy: "" as "" | "help" | "founder",
    destinationError: "",
    wrongAccount: false,
    claimMismatch: false,
    unavailable: false,
    storageError: "",
  });

  function reset(): void {
    const token = local.token;
    const destination = local.destination;
    seq += 1;
    startedToken = null;
    local.started = false; local.token = "";
    local.error = ""; local.name = ""; local.claim = "";
    local.attempted = false; local.busy = false; local.redeemed = false;
    local.redeemedAccountId = ""; local.redeemedNick = "";
    local.destinationBusy = ""; local.destinationError = ""; local.wrongAccount = false;
    local.claimMismatch = false; local.unavailable = false; local.storageError = "";
    // An account switch must not silently drop the capability or its requested destination: reload
    // whatever this browser already remembered so a signed-out reopen keeps its retry identity.
    if (token) start(token, destination);
  }

  function destroy(): void {
    seq += 1;
    startedToken = null;
    local.token = ""; local.started = false;
  }

  // Display only. Never a status lookup, never a redemption, destination or auth POST.
  function start(token: string, destination?: unknown): void {
    const resume = token ? null : readResume();
    const effective = token || resume?.token || "";
    local.destination = normalizeDestination(token ? destination : resume?.destination ?? destination);
    if (effective && startedToken === effective) return;
    startedToken = effective;
    seq += 1;
    local.token = effective;
    local.started = true;
    local.error = ""; local.destinationError = ""; local.wrongAccount = false;
    local.claimMismatch = false; local.unavailable = false;
    if (!effective) {
      local.attempted = false; local.redeemed = false; local.redeemedAccountId = ""; local.redeemedNick = "";
      local.name = ""; local.claim = "";
      local.storageError = "";
      return;
    }
    if (resume) clearResume();
    local.storageError = storageAvailable() ? "" : "This browser cannot remember your attempt. Open this link in a browser that allows site storage, or ask for a new invitation.";
    const stored = readAttempt(effective);
    local.claim = stored?.claim || "";
    local.name = stored?.name || "";
    local.attempted = !!stored;
    local.redeemed = !!stored?.redeemed;
    local.redeemedAccountId = stored?.redeemed?.accountId || "";
    local.redeemedNick = stored?.redeemed?.nick || "";
  }

  async function submit(): Promise<void> {
    if (local.busy || local.redeemed || local.unavailable || !local.token) return;
    const token = local.token;
    let name = local.name.trim();
    if (!local.attempted && !name) { local.error = "Enter a display name."; return; }
    if (name.length > 80) { local.error = "Names are limited to 80 characters."; return; }
    if (!local.attempted && !storageAvailable()) {
      local.storageError = "This browser cannot remember your attempt. Open this link in a browser that allows site storage, or ask for a new invitation.";
      return;
    }
    let claim = local.claim;
    if (local.attempted) {
      // The frozen identity, not the live field, is what a retry must replay.
      const stored = readAttempt(token);
      if (stored) { name = stored.name; claim = stored.claim; }
    } else {
      claim = randomClaim();
      if (!writeAttempt(token, { claim, name })) {
        local.storageError = "This browser cannot remember your attempt. Open this link in a browser that allows site storage, or ask for a new invitation.";
        return;
      }
      local.claim = claim;
      local.name = name;
      local.attempted = true;
    }
    if (!claim) { local.error = "This link is missing its invitation code. Open the link from your email again."; return; }
    const authority = authenticatedAccountId();
    const attempt = ++seq;
    local.busy = true; local.error = ""; local.destinationError = ""; local.wrongAccount = false; local.claimMismatch = false;
    try {
      const response = await admissionPost("/api/admission/redeem", { token, browserClaim: claim, name });
      const body = await response.json().catch(() => null);
      if (attempt !== seq || local.token !== token) return;
      if (!response.ok) {
        const parsed = body && typeof body === "object" ? body as Record<string, unknown> : null;
        const message = parsed && typeof parsed.error === "string" ? parsed.error : "";
        if (response.status === 403) {
          local.wrongAccount = true;
          local.error = "This invitation belongs to a different account. Sign out, then open the link from your email again.";
        } else if (response.status === 409) {
          local.claimMismatch = true;
          local.error = "We could not match this attempt to your invitation. Retry in the same browser, or ask the founder for a new invitation.";
        } else if (response.status === 404 || response.status === 410) {
          local.unavailable = true;
          local.error = "This invitation is no longer available. Ask the founder for a new one.";
        } else if (response.status === 400) {
          // The server refused the name before recording a claim: let the person correct it.
          local.error = message || "That display name cannot be used. Choose a different name and try again.";
          local.attempted = false;
          local.claim = "";
          forgetAttempt(token);
        } else {
          local.error = "We could not confirm whether you joined. Retry here, or ask the founder for a new invitation. Do not open this link in another browser.";
        }
        return;
      }
      const result = body as AdmissionRedeemResult;
      if (!result || typeof result.accountId !== "string" || typeof result.nick !== "string") {
        local.error = "We could not confirm whether you joined. Retry here, or ask the founder for a new invitation. Do not open this link in another browser.";
        return;
      }
      local.redeemed = true;
      local.redeemedAccountId = result.accountId;
      local.redeemedNick = result.nick;
      local.error = "";
      writeAttempt(token, { claim, name, redeemed: result });
      // Refresh the session and authorized mapping before opening the requested destination. The
      // redemption set the cookie; connect() opens the account scope for the redeemed account. A
      // scope reset may run admission.reset() here, so re-check the live token instead of the
      // pre-refresh sequence before continuing.
      if (authority !== result.accountId) await connect();
      if (local.token !== token || session.stopped()) return;
      await openDestination(local.destination);
    } catch {
      if (attempt === seq && local.token === token) {
        local.error = "We could not confirm whether you joined. Retry here, or ask the founder for a new invitation. Do not open this link in another browser.";
      }
    } finally {
      if (attempt === seq) local.busy = false;
    }
  }

  async function openDestination(kind?: unknown): Promise<void> {
    if (local.destinationBusy || !local.token) return;
    const destination = normalizeDestination(kind ?? local.destination);
    const token = local.token;
    const attempt = ++seq;
    local.destinationBusy = destination; local.destinationError = "";
    try {
      const response = await admissionPost("/api/admission/destination", { token, destination });
      const body = await response.json().catch(() => null);
      if (attempt !== seq || local.token !== token) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          local.wrongAccount = true;
          local.destinationError = "This invitation belongs to a different account. Sign out, then open the link from your email again.";
        } else {
          local.destinationError = "We could not open that conversation yet. Try again.";
        }
        return;
      }
      const result = (body || {}) as AdmissionDestinationResult;
      await connect();
      // connect() may run an account-scope reset that re-reads this capability; a new sequence is
      // expected there, so only the live token and session decide whether to continue.
      if (local.token !== token || session.stopped()) return;
      if (!destinationReachable(result)) {
        local.destinationError = "You are in, but the conversation is not available yet. Try again.";
        return;
      }
      if (result.type === "direct" && result.nick) void openDirect(result.nick);
      else if (typeof result.channel === "string" && result.channel) openRoom(result.channel);
    } catch {
      if (attempt === seq && local.token === token) local.destinationError = "We could not open that conversation yet. Try again.";
    } finally {
      if (attempt === seq) local.destinationBusy = "";
    }
  }

  function requestSignIn(): void {
    if (local.token) {
      const store = sessionStore();
      const resume: ResumeState = { token: local.token, destination: local.destination };
      try { store?.setItem(RESUME_KEY, JSON.stringify(resume)); } catch { /* the screen still explains the limit */ }
    }
    core.admissionSignIn = true;
  }

  function switchAccount(): void {
    local.wrongAccount = false; local.error = "";
    void logout();
  }

  return Object.assign(local, {
    start, submit, openDestination, requestSignIn, switchAccount, reset, goHome,
    normalizeDestination, randomClaim,
    destroy,
  });
}

// ---------------------------------------------------------------------------
// Founder admissions section (rendered inside the Invitations page)
// ---------------------------------------------------------------------------

export function mergeAdmissionRows(applications: readonly AdmissionApplication[], admissions: readonly Admission[]): AdmissionRow[] {
  const byApplication = new Map<string, Admission>();
  for (const admission of admissions) {
    if (admission && typeof admission.applicationId === "string" && !byApplication.has(admission.applicationId)) {
      byApplication.set(admission.applicationId, admission);
    }
  }
  return applications
    .filter((application): application is AdmissionApplication => !!application && typeof application.id === "string")
    .map((application) => ({ application, admission: byApplication.get(application.id) ?? null }));
}

export function admissionStateLabel(row: AdmissionRow): string {
  const admission = row.admission;
  if (!admission) return "Awaiting review";
  switch (admission.state) {
    case "redeemed": return "Joined";
    case "cancelled": return "Cancelled";
    case "redeeming": return "Redeeming…";
    default: break;
  }
  switch (admission.delivery) {
    case "sending": return "Sending…";
    case "sent": return "Invite sent";
    case "failed": return "Delivery failed";
    case "uncertain": return "Delivery uncertain";
    case "cancelled": return "Delivery cancelled";
    default: return "Ready to send";
  }
}

export function admissionDeliveryDetail(row: AdmissionRow): string {
  const admission = row.admission;
  if (!admission) return "";
  if (admission.delivery === "failed" || admission.delivery === "uncertain") {
    return admission.deliveryError || "The email may not have arrived. Reissue sends a fresh link and invalidates the old one.";
  }
  return "";
}

export function canApproveAdmission(row: AdmissionRow): boolean {
  return !row.admission;
}
export function canReissueAdmission(row: AdmissionRow): boolean {
  // Every unredeemed admission can be reissued, including cancelled, redeeming and expired rows.
  return !!row.admission && row.admission.state !== "redeemed";
}
export function canCancelAdmission(row: AdmissionRow): boolean {
  const state = row.admission?.state;
  return !!row.admission && state !== "redeemed" && state !== "cancelled";
}

// A 500 can still carry the retained admission payload; the row must be rendered from it instead of
// being discarded as a total failure.
export function founderOutcomeAdmission(body: unknown): Admission | null {
  const parsed = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const admission = parsed?.admission;
  return admission && typeof admission === "object" && typeof (admission as Admission).id === "string" ? admission as Admission : null;
}

export interface AdmissionFounderDeps {
  core: Pick<ClientState, "authenticated">;
  session: ClientSession;
}

export function createAdmissionFounder(reactive: <T extends object>(value: T) => T, { core, session }: AdmissionFounderDeps) {
  let invoker: HTMLElement | null = null;
  const local = reactive({
    visible: false,
    checked: false,
    loading: false,
    error: "",
    rowError: "",
    applications: [] as AdmissionApplication[],
    admissions: [] as Admission[],
    busyId: "",
    busyAction: "" as "" | "approve" | "reissue" | "cancel",
    confirmId: "",
  });

  const inScope = (key: string) => session.key() === key && !session.stopped() && core.authenticated;
  const dialog = () => typeof document === "undefined" ? null : document.querySelector<HTMLDialogElement>("#admission-cancel-dialog");

  function reset(): void {
    invoker = null;
    local.visible = false; local.checked = false; local.loading = false; local.error = ""; local.rowError = "";
    local.applications = []; local.admissions = []; local.busyId = ""; local.busyAction = ""; local.confirmId = "";
    if (typeof document !== "undefined") document.querySelector<HTMLDialogElement>("#admission-cancel-dialog")?.close();
  }

  function rows(): AdmissionRow[] {
    return mergeAdmissionRows(local.applications, local.admissions);
  }

  function merge(admission: Admission): void {
    if (!admission || typeof admission.id !== "string") return;
    const next = local.admissions.filter((item) => item.id !== admission.id && item.applicationId !== admission.applicationId);
    local.admissions = [...next, admission];
  }

  async function load(): Promise<void> {
    if (!core.authenticated || local.loading) return;
    const key = session.key();
    local.loading = true; local.error = "";
    try {
      const response = await fetch("/api/admissions", { credentials: "same-origin" });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!inScope(key)) return;
      if (response.status === 404) {
        local.visible = false; local.checked = true;
        local.applications = []; local.admissions = [];
        return;
      }
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not load admission requests.");
      local.applications = Array.isArray(body.applications) ? body.applications as AdmissionApplication[] : [];
      local.admissions = Array.isArray(body.admissions) ? body.admissions as Admission[] : [];
      local.visible = true; local.checked = true;
    } catch {
      if (!inScope(key)) return;
      // A transport failure is not an empty list: keep the section (and its error) visible.
      local.visible = true; local.checked = true;
      local.error = "Could not load admission requests. Your existing invitations are unchanged.";
    } finally {
      if (inScope(key)) local.loading = false;
    }
  }

  function open(): void {
    if (!core.authenticated || local.checked || local.loading) return;
    void load();
  }

  async function reload(): Promise<void> {
    if (!core.authenticated || local.loading) return;
    local.checked = false; local.error = "";
    await load();
  }

  async function run(row: AdmissionRow, action: "approve" | "reissue" | "cancel"): Promise<void> {
    if (local.busyId || !core.authenticated) return;
    const key = session.key();
    const admission = row.admission;
    local.busyId = row.application.id; local.busyAction = action; local.rowError = ""; local.confirmId = "";
    try {
      let response: Response;
      if (action === "approve") {
        response = await admissionPost("/api/admissions/approve", { applicationId: row.application.id, revision: row.application.revision });
      } else if (action === "reissue" && admission) {
        response = await admissionPost(`/api/admissions/${encodeURIComponent(admission.id)}/reissue`, { revision: admission.revision });
      } else if (action === "cancel" && admission) {
        response = await admissionPost(`/api/admissions/${encodeURIComponent(admission.id)}/cancel`, {});
      } else {
        return;
      }
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!inScope(key)) return;
      const parsed = body || {};
      const next = founderOutcomeAdmission(parsed);
      if (next) merge(next);
      if (action === "cancel" && parsed.cancelled === true && admission) {
        merge({ ...admission, state: "cancelled" });
        return;
      }
      if (!response.ok) {
        if (response.status === 409) local.rowError = "That request changed while you were reviewing it. Reloading the current state.";
        else if (response.status === 503) local.rowError = "Email is temporarily unavailable. Try again shortly.";
        else local.rowError = typeof parsed.error === "string" ? parsed.error : "That action did not complete.";
        void load();
        return;
      }
    } catch {
      if (inScope(key)) local.rowError = "Could not reach the server. Try again.";
    } finally {
      if (inScope(key)) { local.busyId = ""; local.busyAction = ""; }
    }
  }

  const approve = (row: AdmissionRow) => run(row, "approve");
  const reissue = (row: AdmissionRow) => run(row, "reissue");
  const cancel = (row: AdmissionRow) => run(row, "cancel");

  function askCancel(event: Event, row: AdmissionRow): void {
    if (local.busyId || !canCancelAdmission(row)) return;
    invoker = (event?.currentTarget as HTMLElement | null) ?? null;
    local.confirmId = row.application.id;
    void (async () => {
      const element = dialog();
      if (!element) return;
      element.showModal();
      await new Promise((resolve) => setTimeout(resolve, 0));
      element.querySelector<HTMLButtonElement>("[data-admission-cancel-safe]")?.focus();
    })();
  }

  function closeConfirm(): void {
    if (local.busyAction === "cancel") return;
    local.confirmId = "";
    dialog()?.close();
    if (invoker?.isConnected) invoker.focus();
    invoker = null;
  }

  function confirmRow(): AdmissionRow | null {
    return rows().find((row) => row.application.id === local.confirmId) ?? null;
  }

  async function confirmCancel(): Promise<void> {
    const row = confirmRow();
    if (!row) return;
    await cancel(row);
    if (!local.busyAction && !local.busyId) closeConfirm();
  }

  return Object.assign(local, {
    open, load, reload, approve, reissue, cancel, askCancel, closeConfirm, confirmCancel, reset,
    rows, canApproveAdmission, canReissueAdmission, canCancelAdmission, admissionStateLabel, admissionDeliveryDetail,
    destroy: reset,
  });
}

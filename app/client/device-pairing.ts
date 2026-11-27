import { type ClientSession, type ClientState } from "@client/client-state.ts";
import { editPairCode, isPairCodeComplete, normalizePairCode, pairDeliveryUrl, pairDigitInput, pairRequestUrl } from "@client/pairing.ts";

export function createDevicePairing(reactive: <T extends object>(value: T) => T, { core, nextTick, session, suspended, viewEpoch, email: readEmail, onDirect = () => {}, onChannels = () => {}, onAgentPresence = () => {}, onAgentUpdated = () => {}, onAgentRemoved = () => {}, onAgentPending = () => {}, onAgentConnectRequest = () => {}, onAgentRequests = () => {}, onOfferRedeemed = () => {}, onNotes = () => {}, onReplyThreads = () => {}, onPoll = () => {}, onNotify = () => {}, onStreamReady = () => {} }: {
  core: Pick<ClientState, "authenticated">;
  nextTick: (callback?: () => void) => Promise<void>;
  session: ClientSession;
  suspended: () => boolean;
  viewEpoch: () => number;
  email: () => string;
  // The same stream carries DM wake-ups: a message landed in a DM this tab may not hold yet.
  onDirect?: (channel: string) => void;
  // And channel list changes made elsewhere: this account joined or left `channel`.
  onChannels?: (channel: string, member: boolean, deleted: boolean) => void;
  // And agent attachment flips for the presence dot.
  onAgentPresence?: (nick: string, attached: boolean) => void;
  // And agent profile changes (name, repo, model), including a freshly paired agent.
  onAgentUpdated?: (data: { nick: string; agent?: unknown }) => void;
  onAgentRemoved?: (nick: string) => void;
  /** A coding session is waiting for this owner's Allow, or one was just decided. */
  onAgentPending?: () => void;
  /** A session ran the command this owner copied (its ticket named them): the Allow card's data. */
  onAgentConnectRequest?: (data: unknown) => void;
  onAgentRequests?: (data: { accountId: string; requests: { channel: string; messageId: string; state: "Queued" | "Working" }[] } | null) => void;
  // And the notice that a phone redeemed an "Add your phone" offer (phone-offer.ts).
  onOfferRedeemed?: (data: unknown) => void;
  // And Notes changed on another tab or device: reload the list.
  onNotes?: () => void;
  onReplyThreads?: () => void;
  // And a poll in one of this account's channels changed: a vote, an unvote or a close.
  onPoll?: (id: number) => void;
  // And a notification for this account, which the Mac app shows natively (native-shell.ts).
  onNotify?: (data: unknown) => void;
  // The stream (re)connected; anything it carries may have changed while it was down.
  onStreamReady?: () => void;
}) {
  let pairEvents: EventSource | null = null;
  let pairEventScope = "";
  let pairEpoch = 0;
  let pairPollTimer: number | null = null;
  const local = reactive({
    pairCode: "",
    pairSecret: "",
    pairUrl: "",
    pairError: "",
    pairBusy: false,
    pendingPair: null as any,
    approvalCode: "",
    approvalError: "",
    approvalBusy: false,
    pairLookupDraft: "",
  });
  function renderPairQr(element: HTMLElement, text: string): void {
    const create = (window as any).qrcode;
    if (!create || !text) return;
    const qr = create(0, "M"); qr.addData(text); qr.make();
    element.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, title: "Pairing QR code" });
  }

  function startPair(): Promise<void> { return beginPair(); }

  async function approvePair(): Promise<void> { await answerPair("allow"); }

  async function denyPair(): Promise<void> { await answerPair("deny"); }

  function focusPairDigit(input: HTMLInputElement, index: number): void {
    const next = input.closest(".pair-code-digits")?.querySelectorAll<HTMLInputElement>("input")[index];
    next?.focus(); next?.select();
  }

  function updatePairDigit(input: HTMLInputElement, index: number, text: string): void {
    const next = editPairCode(local.pairLookupDraft, index, text);
    local.pairLookupDraft = next.value;
    local.approvalError = "";
    input.value = next.value[index]?.trim() || "";
    // Alpine must paint pasted digits before selecting the next field.
    void nextTick(() => focusPairDigit(input, next.focus));
  }

  function pairCodeInput(event: InputEvent, index: number): void {
    if (event.isComposing) return;
    const input = event.target as HTMLInputElement;
    updatePairDigit(input, index, pairDigitInput(event.inputType, event.data, input.value));
  }

  function pairCodePaste(event: ClipboardEvent, index: number): void {
    event.preventDefault();
    updatePairDigit(event.target as HTMLInputElement, index, event.clipboardData?.getData("text") || "");
  }

  function pairCodeKeydown(event: KeyboardEvent, index: number): void {
    const input = event.target as HTMLInputElement;
    if (event.key === "Backspace") {
      event.preventDefault();
      const target = input.value ? index : Math.max(0, index - 1);
      local.pairLookupDraft = editPairCode(local.pairLookupDraft, target, "").value;
      local.approvalError = "";
      void nextTick(() => focusPairDigit(input, target));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      focusPairDigit(input, Math.max(0, Math.min(5, index + (event.key === "ArrowLeft" ? -1 : 1))));
    }
  }

  function pairCodeComplete(): boolean {
    return isPairCodeComplete(local.pairLookupDraft);
  }

  async function lookupPair(): Promise<void> {
    const code = normalizePairCode(String(local.pairLookupDraft || ""));
    if (!code) { local.approvalError = "Pair codes have six digits."; return; }
    if (local.approvalBusy) return;
    const epoch = pairEpoch;
    const ownerScope = session.key();
    local.approvalBusy = true; local.approvalError = "";
    try {
      const response = await fetch(`/api/pair/pending?code=${encodeURIComponent(code)}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => []);
      if (epoch !== pairEpoch || ownerScope !== session.key() || session.stopped() || suspended()) return;
      if (!response.ok) throw new Error(body.error || `Could not check code (${response.status}).`);
      const request = Array.isArray(body) ? body[0] : null;
      if (!request) throw new Error("No pending sign-in found for this account.");
      pairEpoch += 1;
      local.pendingPair = request; local.approvalCode = code; local.pairLookupDraft = ""; local.approvalBusy = false;
    } catch (error) {
      if (epoch === pairEpoch && ownerScope === session.key() && !session.stopped() && !suspended()) local.approvalError = error instanceof Error ? error.message : "Could not check pairing code.";
    } finally { if (epoch === pairEpoch) local.approvalBusy = false; }
  }

  function clearPairRequest(clearError = true): void {
    pairEpoch += 1;
    if (pairPollTimer !== null) clearTimeout(pairPollTimer);
    pairPollTimer = null;
    local.pairCode = ""; local.pairSecret = ""; local.pairUrl = ""; local.pairBusy = false;
    // The pair request epoch has changed; drop any pending approval state so a stale
    // answerPair can no longer keep approvalBusy true and strand the buttons.
    local.pendingPair = null; local.approvalCode = ""; local.approvalError = ""; local.approvalBusy = false;
    if (clearError) local.pairError = "";
  }

  async function beginPair(): Promise<void> {
    if (local.pairBusy) return;
    clearPairRequest();
    const emailInput = document.querySelector<HTMLInputElement>('.auth-modal input[type="email"]');
    const email = String(emailInput?.value ?? readEmail()).trim();
    if (email && emailInput && !emailInput.checkValidity()) { emailInput.reportValidity(); local.pairError = "Enter a valid email, or clear it to link with a code."; return; }
    const epoch = pairEpoch;
    local.pairBusy = true;
    try {
      const r = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "session", email }) });
      const body = await r.json();
      if (epoch !== pairEpoch || session.stopped() || suspended()) return;
      if (!r.ok) throw new Error(body.error || `Pair request failed (${r.status})`);
      local.pairCode = body.code; local.pairSecret = body.secret; local.pairUrl = pairRequestUrl(location.origin, body.code);
      const poll = async () => {
        if (epoch !== pairEpoch || session.stopped() || suspended()) return;
        try {
          const response = await fetch(`/api/pair/${encodeURIComponent(body.code)}`, { headers: { "X-Pair-Secret": body.secret } });
          const result = await response.json();
          if (epoch !== pairEpoch || session.stopped() || suspended()) return;
          if (result.loginToken) {
            const destination = pairDeliveryUrl(body.code, result.loginToken);
            clearPairRequest(); location.href = destination;
          } else if (!response.ok) {
            const error = result.error || "Pairing expired or was declined.";
            clearPairRequest(false); local.pairError = error;
          } else pairPollTimer = globalThis.setTimeout(poll, 2000) as unknown as number;
        } catch {
          if (epoch === pairEpoch && !session.stopped() && !suspended()) { clearPairRequest(false); local.pairError = "Could not check pairing status."; }
        }
      };
      void poll();
    } catch (error) {
      if (epoch === pairEpoch && !session.stopped() && !suspended()) { clearPairRequest(false); local.pairError = error instanceof Error ? error.message : "Could not start pairing."; }
    } finally {
      if (epoch === pairEpoch) local.pairBusy = false;
    }
  }

  async function answerPair(action: "allow" | "deny"): Promise<void> {
    if (local.approvalBusy || !local.approvalCode) return;
    const code = local.approvalCode;
    const epoch = pairEpoch;
    const ownerScope = session.key();
    local.approvalBusy = true; local.approvalError = "";
    try {
      const r = await fetch(`/api/pair/${encodeURIComponent(code)}/${action}`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (epoch !== pairEpoch || ownerScope !== session.key() || session.stopped() || suspended()) return;
      if (!r.ok) throw new Error(body.error || `Approval failed (${r.status})`);
      local.pendingPair = action === "allow" ? "approved" : "denied";
    } catch (error) {
      if (epoch === pairEpoch && ownerScope === session.key() && !session.stopped() && !suspended()) local.approvalError = error instanceof Error ? error.message : "Could not answer request.";
    } finally { if (epoch === pairEpoch) local.approvalBusy = false; }
  }

  function authorize(key: string): void {
    local.approvalCode = new URLSearchParams(location.search).get("pair") || "";
    if (pairEventScope !== key) {
      pairEvents?.close();
      pairEventScope = key;
      onAgentRequests(null);
      pairEvents = new EventSource("/api/events");
      const source = pairEvents;
      const requestEventsCurrent = () => pairEvents === source && pairEventScope === key && !session.stopped() && !suspended() && core.authenticated;
      pairEvents.addEventListener("agent-requests", (event) => {
        if (!requestEventsCurrent()) return;
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.accountId === "string" && Array.isArray(data.requests) && data.requests.every((row: any) =>
            typeof row?.channel === "string" && typeof row.messageId === "string" && ["Queued", "Working"].includes(row.state))) onAgentRequests(data);
        } catch {}
      });
      pairEvents.addEventListener("error", () => { if (requestEventsCurrent()) onAgentRequests(null); });
      pairEvents.addEventListener("pair-request", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try {
          const request = JSON.parse((event as MessageEvent).data);
          if (request?.code) {
            if (request.code !== local.approvalCode) pairEpoch += 1;
            local.pendingPair = request; local.approvalCode = request.code; local.approvalBusy = false;
          }
        } catch { local.approvalError = "Could not read pairing request."; }
      });
      pairEvents.addEventListener("pair-offer", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try { onOfferRedeemed(JSON.parse((event as MessageEvent).data)); } catch {}
      });
      pairEvents.addEventListener("direct", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.channel === "string") onDirect(data.channel);
        } catch {}
      });
      pairEvents.addEventListener("ready", () => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        onStreamReady();
      });
      pairEvents.addEventListener("poll", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (Number.isSafeInteger(data?.id)) onPoll(data.id);
        } catch {}
      });
      pairEvents.addEventListener("notify", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try { onNotify(JSON.parse((event as MessageEvent).data)); } catch {}
      });
      pairEvents.addEventListener("notes", () => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        onNotes();
      });
      pairEvents.addEventListener("reply-threads", () => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        onReplyThreads();
      });
      pairEvents.addEventListener("channels", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.channel === "string" && typeof data.member === "boolean") onChannels(data.channel, data.member, data.deleted === true);
        } catch {}
      });
      pairEvents.addEventListener("agent-presence", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.nick === "string" && typeof data.attached === "boolean") onAgentPresence(data.nick, data.attached);
        } catch {}
      });
      pairEvents.addEventListener("agent-removed", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.nick === "string" && data.nick) onAgentRemoved(data.nick);
        } catch {}
      });
      pairEvents.addEventListener("agent-updated", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.nick === "string" && data.nick) onAgentUpdated(data);
        } catch {}
      });
      pairEvents.addEventListener("agent-connect-request", (event) => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        try { onAgentConnectRequest(JSON.parse((event as MessageEvent).data)); } catch {}
      });
      pairEvents.addEventListener("agent-pending", () => {
        if (pairEventScope !== key || session.stopped() || !core.authenticated) return;
        onAgentPending();
      });
    }
  }

  function loadPending(key: string): void {
    const approvalCode = local.approvalCode;
    const approvalEpoch = viewEpoch();
    const approvalPairEpoch = pairEpoch;
    if (approvalCode) void fetch(`/api/pair/pending?code=${encodeURIComponent(approvalCode)}`, { credentials: "same-origin" }).then(async (response) => {
      const body = await response.json().catch(() => []);
      if (session.key() !== key || viewEpoch() !== approvalEpoch || pairEpoch !== approvalPairEpoch || session.stopped()) return;
      if (!response.ok) throw new Error(body.error || `Could not load pairing request (${response.status}).`);
      local.pendingPair = Array.isArray(body) ? body[0] || null : null;
      if (!local.pendingPair) local.approvalError = "No pending sign-in found for this account.";
    }).catch((error) => { if (session.key() === key && viewEpoch() === approvalEpoch && pairEpoch === approvalPairEpoch && !session.stopped()) local.approvalError = error instanceof Error ? error.message : "Could not load pairing request."; });
  }
  function stop(): void {
    clearPairRequest();
    pairEvents?.close(); pairEvents = null; pairEventScope = "";
    onAgentRequests(null);
  }
  return Object.assign(local, {
    renderPairQr, startPair, approvePair, denyPair, focusPairDigit, updatePairDigit, pairCodeInput, pairCodePaste, pairCodeKeydown, pairCodeComplete, lookupPair, clearPairRequest, beginPair, answerPair, authorize, loadPending, stop,
    destroy: stop,
  });
}

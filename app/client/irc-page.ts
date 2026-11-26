import { type ClientSession, type ClientState } from "@client/client-state.ts";
import { workspaceName } from "@client/workspace-mark.ts";

type IrcDevice = { id: string; label: string; createdAt: number };
type IrcCertificate = IrcDevice & { fingerprint: string };
type RemoveTarget = { ids: { kind: "device" | "certificate"; id: string }[]; label: string };
// One line per value: a CR/LF in an account or password would break the pasted config syntax.
const cleanLine = (value: string): string => value.replace(/[\r\n]+/g, " ");

function ircServerName(host: string): string {
  const slug = workspaceName(host).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug === "slirc" || slug === "localhost" || /^\d+$/.test(slug)) return "slirc";
  return `slirc-${slug}`;
}

export type IrcConnection = NonNullable<ClientState["ircConnection"]>;

// Server metadata only; never inferred from the page protocol or hostname. Missing or malformed
// fields fail closed to verified public TLS with no self-signed exception.
export function normalizeIrcConnection(value: unknown): IrcConnection | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || typeof raw.host !== "string") return null;
  const port = Number(raw.port);
  return {
    host: raw.host.trim(),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 6697,
    tls: raw.tls !== false,
    allowSelfSigned: raw.allowSelfSigned === true,
    local: raw.local === true,
  };
}

// IRC clients page. Credentials live on the server (`/api/irc/*`); this page only lists them and
// relays create/remove. A generated password is shown once and never persisted.
export function createIrcPage(reactive: <T extends object>(value: T) => T, { core, session, nextTick }: {
  core: Pick<ClientState, "authenticated" | "account" | "ircConnection" | "ircReset">;
  session: ClientSession;
  nextTick: (callback?: () => void) => Promise<void>;
}) {
  let epoch = 0;
  let invoker: HTMLElement | null = null;
  const local = reactive({
    loading: false,
    loaded: false,
    busy: false,
    error: "",
    devices: [] as IrcDevice[],
    certificates: [] as IrcCertificate[],
    password: "",
    passwordOpen: false,
    passwordName: "",
    certificateOpen: false,
    certificateName: "",
    certificateFingerprint: "",
    removeTarget: null as RemoveTarget | null,
    copied: "",
  });

  function owner() {
    const scope = session.scope();
    if (!scope || !core.authenticated || scope.account !== core.account || session.stopped() || session.signingOut()) return null;
    const key = session.key(), revision = epoch;
    return { account: scope.account, current: () => epoch === revision && session.key() === key
      && session.scope()?.account === scope.account && core.authenticated && core.account === scope.account
      && !session.stopped() && !session.signingOut() };
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(path, { credentials: "same-origin", signal: AbortSignal.timeout(15_000), ...init });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status}).`);
    }
    return response;
  }

  async function load(): Promise<void> {
    const scope = owner();
    if (!scope || local.loading || local.busy) return;
    local.loading = true; local.error = ""; local.loaded = false;
    try {
      const [devices, certificates] = await Promise.all([
        request("/api/irc/devices").then((response) => response.json()),
        request("/api/irc/certificates").then((response) => response.json()),
      ]);
      if (!scope.current()) return;
      if (!Array.isArray(devices) || !Array.isArray(certificates)) throw new Error("Could not read IRC clients.");
      local.devices = devices; local.certificates = certificates; local.loaded = true;
    } catch (error) {
      if (scope.current()) local.error = error instanceof Error ? error.message : "Could not load IRC clients.";
    } finally { if (scope.current()) local.loading = false; }
  }

  async function addPassword(): Promise<void> {
    const scope = owner();
    if (!scope || local.busy || !local.passwordName.trim()) return;
    local.busy = true; local.error = "";
    try {
      const body = await (await request("/api/irc/devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: local.passwordName.trim() }) })).json();
      if (!scope.current()) return;
      local.devices = [body.device, ...local.devices];
      local.password = body.password;
      core.ircReset = { ...core.ircReset, clients: false };
      local.passwordName = ""; local.passwordOpen = false; local.loaded = true;
    } catch (error) {
      if (scope.current()) local.error = error instanceof Error ? error.message : "Could not connect IRC client.";
    } finally { if (scope.current()) local.busy = false; }
  }

  // A new shared password without adding a client: the one to paste into every password client.
  async function newPassword(): Promise<void> {
    const scope = owner();
    if (!scope || local.busy) return;
    local.busy = true; local.error = "";
    try {
      const body = await (await request("/api/irc/password", { method: "POST" })).json();
      if (!scope.current()) return;
      local.password = body.password;
      core.ircReset = { ...core.ircReset, clients: false };
    } catch (error) {
      if (scope.current()) local.error = error instanceof Error ? error.message : "Could not make a new IRC password.";
    } finally { if (scope.current()) local.busy = false; }
  }

  async function addCertificate(): Promise<void> {
    const scope = owner();
    if (!scope || local.busy || !local.certificateName.trim() || !local.certificateFingerprint.trim()) return;
    local.busy = true; local.error = "";
    try {
      const body = await (await request("/api/irc/certificates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: local.certificateName.trim(), fingerprint: local.certificateFingerprint }) })).json();
      if (!scope.current()) return;
      local.certificates = [body, ...local.certificates];
      local.certificateName = ""; local.certificateFingerprint = ""; local.certificateOpen = false; local.loaded = true;
    } catch (error) {
      if (scope.current()) local.error = error instanceof Error ? error.message : "Could not add certificate.";
    } finally { if (scope.current()) local.busy = false; }
  }

  function askRemove(target: RemoveTarget, button: HTMLElement): void {
    if (!owner() || local.busy || !target.ids.length) return;
    invoker = button;
    local.removeTarget = target;
  }

  function allTarget(): RemoveTarget {
    return {
      ids: [
        ...local.certificates.map((item) => ({ kind: "certificate" as const, id: item.id })),
        ...local.devices.map((item) => ({ kind: "device" as const, id: item.id })),
      ],
      label: "all IRC clients",
    };
  }

  function removeMessage(): string {
    const target = local.removeTarget;
    if (!target) return "";
    const hasDevice = target.ids.some((item) => item.kind === "device");
    if (!hasDevice) return "This certificate will stop authenticating immediately.";
    return target.ids.length > 1 || target.ids.some((item) => item.kind === "certificate")
      ? "Every certificate stops authenticating and the IRC password rotates. All IRC clients disconnect."
      : "This rotates your IRC password. Other password clients will also need the new password.";
  }

  function closeRemove(): void {
    local.removeTarget = null;
    void nextTick(() => {
      if (invoker?.isConnected && invoker.getClientRects().length) invoker.focus();
      invoker = null;
    });
  }

  async function confirmRemove(): Promise<void> {
    const scope = owner(), target = local.removeTarget;
    if (!scope || !target || local.busy) return;
    local.busy = true; local.error = "";
    try {
      for (const entry of [...target.ids]) {
        if (!scope.current()) return;
        const response = await request(`/api/irc/${entry.kind === "certificate" ? "certificates" : "devices"}/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
        if (!scope.current()) return;
        if (entry.kind === "certificate") {
          local.certificates = local.certificates.filter((item) => item.id !== entry.id);
        } else {
          const body = await response.json().catch(() => ({}));
          local.password = body.password;
          local.devices = local.devices.filter((item) => item.id !== entry.id);
        }
        target.ids = target.ids.filter((item) => item.id !== entry.id);
      }
      if (scope.current()) closeRemove();
    } catch (error) {
      if (scope.current()) local.error = error instanceof Error ? error.message : "Could not remove IRC client.";
    } finally { if (scope.current()) local.busy = false; }
  }

  function dialogKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget as HTMLDialogElement;
    const controls = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter((button) => button.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  }

  async function copy(text: string, key = text): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      local.copied = key;
      setTimeout(() => { if (local.copied === key) local.copied = ""; }, 2_200);
    } catch { /* clipboard unavailable; the text stays selectable */ }
  }

  function configs(): { name: string; text: string }[] {
    if (!local.password) return [];
    const meta = core.ircConnection;
    const host = cleanLine(meta?.host || (typeof location !== "undefined" ? location.hostname : "localhost"));
    const port = Number.isInteger(meta?.port) ? meta!.port : 6697;
    const tls = meta ? meta.tls !== false : true;
    const selfSigned = meta?.allowSelfSigned === true;
    const nick = cleanLine(String(core.account ?? ""));
    const password = cleanLine(local.password);
    const endpoint = `${host}:${port}`;
    const server = ircServerName(host);
    // A TOML string needs backslashes and quotes escaped; the local-only warning is part of the
    // pasted config so it cannot be mistaken for a production endpoint.
    const toml = (value: string) => cleanLine(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const halloySelfSigned = selfSigned
      ? `# x1 / this machine only: ${host} is not reachable from another computer.\n# Accepts this instance's self-signed local IRC certificate. Do not use this config for production.\ndangerously_accept_invalid_certs = true\n`
      : "";
    return [
      { name: "Halloy", text: `[servers.${server}]\nserver = "${toml(host)}"\nport = ${port}\nuse_tls = ${tls ? "true" : "false"}\n${halloySelfSigned}nickname = "${toml(nick)}"\nusername = "${toml(nick)}"\n\n[servers.${server}.sasl.plain]\nusername = "${toml(nick)}"\npassword = "${toml(password)}"\n` },
      { name: "Senpai", text: `address ${endpoint}\nnickname ${nick}\nusername ${nick}\npassword ${password}\n` },
      { name: "WeeChat", text: `/server add ${server} ${endpoint} -ssl\n/set irc.server.${server}.nicks "${nick}"\n/set irc.server.${server}.sasl_username "${nick}"\n/set irc.server.${server}.sasl_password "${password}"\n/set irc.server.${server}.sasl_mechanism plain\n/connect ${server}\n` },
      { name: "Textual", text: `Server: ${host}\nPort: ${port}\nSecure connection: ${tls ? "Yes" : "No"}\nNickname: ${nick}\nUsername: ${nick}\nPassword: ${password}\nAuthentication: SASL PLAIN\n` },
    ];
  }

  function selfSigned(): boolean { return core.ircConnection?.allowSelfSigned === true; }
  function localOnly(): boolean { return core.ircConnection?.local === true; }
  function connectionNote(): string {
    const connection = core.ircConnection;
    if (!connection?.local) return "";
    const endpoint = `${connection.host}:${connection.port}`;
    return connection.allowSelfSigned
      ? `Local connection to ${endpoint} (x1 / this machine only). Halloy accepts this instance's self-signed certificate below; other clients need their own certificate-trust setup and fail TLS verification until then.`
      : `Local connection to ${endpoint} (this machine only).`;
  }

  function reset(): void {
    epoch += 1; invoker = null;
    local.loading = false; local.loaded = false; local.busy = false; local.error = "";
    local.devices = []; local.certificates = []; local.password = "";
    local.passwordOpen = false; local.passwordName = "";
    local.certificateOpen = false; local.certificateName = ""; local.certificateFingerprint = "";
    local.removeTarget = null; local.copied = "";
  }

  function open(): void { void load(); }

  return Object.assign(local, { load, addPassword, newPassword, addCertificate, askRemove, allTarget, removeMessage, closeRemove, confirmRemove, dialogKeydown, copy, configs, selfSigned, localOnly, connectionNote, open, reset, destroy: reset,
    date: (timestamp: number) => new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
  });
}

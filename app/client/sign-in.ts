import { type ClientState } from "@client/client-state.ts";
import { validSignInEmail } from "@client/pairing.ts";
import { routeFromMount, signInNext } from "@client/presentation.ts";

// Same rule as the server's isValidNext: a plain same-site path. A backslash or a second slash
// would let the browser leave the site.
const safeNext = (next: unknown): string =>
  typeof next === "string" && next.length <= 200 && /^\/[a-zA-Z0-9._/-]*$/.test(next) && !next.startsWith("//") ? next : "/";

export function createSignIn(reactive: <T extends object>(value: T) => T, core: Pick<ClientState, "error">, navigate: (next: string) => void = (next) => location.assign(next)) {
  const local = reactive({
    email: "",
    // Public playground only: the nick a new address starts with. Ignored for an existing account.
    name: "",
    linkBusy: false,
    linkSent: false,
    devLink: "",
    code: "",
    codeBusy: false,
    codeError: "",
  });
  // Set by requestLink; /auth/code returns the same validated target.
  let codeNext = "/";
  async function requestLink(): Promise<void> {
    if (local.linkBusy) return;
    local.linkBusy = true;
    core.error = "";
    local.linkSent = false;
    local.code = "";
    local.codeError = "";
    const email = String(local.email || "").trim();
    if (!validSignInEmail(email)) {
      core.error = "Enter a valid email.";
      local.linkBusy = false;
      return;
    }
    try {
      // Local devLinks mode returns 200 { devLink }; production answers 204 with no body.
      // The return target is the current canonical root route, never a hardcoded mount;
      // /auth/verify redirects the signed-in tab back here.
      const currentRoute = routeFromMount(location.pathname, location.hash, location.search);
      codeNext = signInNext(currentRoute, location.origin);
      const response = await fetch("/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: String(local.name || "").trim().slice(0, 80), next: codeNext }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed (${response.status})`);
      }
      const body = (await response.json().catch(() => ({}))) as { devLink?: unknown };
      local.devLink = typeof body.devLink === "string" ? body.devLink : "";
      local.linkSent = true;
    } catch (error) {
      core.error = error instanceof Error ? error.message : "Could not send the link.";
    } finally {
      local.linkBusy = false;
    }
  }
  // The email carries a 6-digit code next to the link. Typing it here signs in this tab, so nobody
  // has to leave it for the mail app. The link keeps working for whoever taps it instead.
  function codeInput(): void {
    local.code = String(local.code || "").replace(/\D/g, "").slice(0, 6);
    local.codeError = "";
    if (local.code.length === 6) void submitCode();
  }
  async function submitCode(): Promise<void> {
    if (local.codeBusy) return;
    const code = String(local.code || "").replace(/\D/g, "");
    if (code.length !== 6) {
      local.codeError = "Enter the 6-digit code.";
      return;
    }
    local.codeBusy = true;
    local.codeError = "";
    try {
      const response = await fetch("/auth/code", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Sign-In": "1" },
        body: JSON.stringify({ email: String(local.email || "").trim(), code, next: codeNext }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; next?: unknown };
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      // The session cookie is set; a full load boots the signed-in client at the return target.
      navigate(safeNext(body.next));
    } catch (error) {
      local.code = "";
      local.codeError = error instanceof Error ? error.message : "Could not check the code.";
      local.codeBusy = false;
    }
  }
  function reset(): void {
    local.linkSent = false;
    local.devLink = "";
    local.code = "";
    local.codeError = "";
    core.error = "";
  }
  // A good code leaves the form busy until the page unloads. A page restored from the back/forward
  // cache never unloaded, so free the form again.
  function restored(): void { local.codeBusy = false; }
  return Object.assign(local, { requestLink, codeInput, submitCode, reset, restored });
}

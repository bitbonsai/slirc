// The Mac app's workspace picker, for when no signed-in workspace page can show the web client's
// workspace dialog: the first launch, after a sign-out, the sign-in screen and Switch Workspace on
// the unreachable screen (mac-unreachable.js). It looks like that dialog (app/partials/workspace-dialog.html) and draws its marks with
// the same code (workspace-mark.js). The app keeps the saved list and checks every address, so
// the page only shows rows and posts what was picked:
//   window.SlircPicker = { workspaces, selected, back, message, text }, set by AppDelegate.swift
//   webkit.messageHandlers.slircPicker.postMessage({ open } | { remove } | { cancel } | { quit })
//   window.slircPickerFailed(message, text), the app's answer when a check fails
// The pure part, pickerRows, is tested in app/test/desktop-picker.test.ts.
(() => {
  // A saved origin's label: its host, or the full address when it has a port (a local dev stack).
  function label(origin) {
    const host = origin.replace(/^https:\/\//, "");
    return host.includes(":") ? origin : host;
  }

  // One row per workspace saved on this Mac, in the order first opened, then app.slirc.org when it
  // isn't among them. Only saved rows can be removed.
  function pickerRows(workspaces, selected) {
    const { workspaceMark, OPEN_WORKSPACE } = globalThis.slircWorkspaceMark;
    const row = (origin, saved, note) => ({ ...workspaceMark(origin.replace(/^https:\/\//, ""), origin), origin, label: label(origin), saved, selected: origin === selected, note });
    const rows = workspaces.map((origin) => row(origin, true, ""));
    if (!workspaces.includes(OPEN_WORKSPACE)) rows.push(row(OPEN_WORKSPACE, false, "Slirc's own workspace"));
    return rows;
  }

  globalThis.slircMacPicker = { label, pickerRows };
  if (typeof document === "undefined") return;

  const state = { workspaces: [], selected: null, back: null, message: "", text: "", ...(window.SlircPicker || {}) };
  let workspaces = [...state.workspaces];
  const post = (body) => window.webkit?.messageHandlers?.slircPicker?.postMessage(body);
  const list = document.querySelector(".workspace-list");
  const form = document.querySelector("form");
  const field = form.querySelector("input");
  const submit = form.querySelector("button[type=submit]");
  const error = document.querySelector("[role=alert]");
  const lead = document.querySelector(".lead");
  const leave = document.querySelector(".leave");
  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  const CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  const canGoBack = () => !!state.back && workspaces.includes(state.back);

  function busy(on) {
    for (const control of document.querySelectorAll("button, input")) control.disabled = on;
    if (!on) submit.disabled = !field.value.trim();
  }

  function render() {
    lead.textContent = workspaces.length
      ? "Pick a workspace you've opened on this Mac, or enter a different address. Each workspace keeps its own sign-in."
      : "Enter the address your team uses for Slirc. We remember it on this Mac.";
    form.querySelector("label").textContent = workspaces.length ? "Open another workspace" : "Workspace address";
    leave.textContent = canGoBack() ? "Cancel" : "Quit";
    const rows = pickerRows(workspaces, state.selected);
    const stop = (rows.find((item) => item.selected) || rows[0]).origin;
    list.replaceChildren(...rows.map((item) => {
      const wrap = document.createElement("div");
      wrap.className = "workspace-item";
      wrap.setAttribute("role", "listitem");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "workspace-row";
      open.dataset.origin = item.origin;
      if (item.selected) open.setAttribute("aria-current", "true");
      open.tabIndex = item.origin === stop ? 0 : -1;
      if (item.saved) open.setAttribute("aria-keyshortcuts", "Delete");
      const badge = document.createElement("span");
      badge.className = "workspace-badge" + (item.logo ? " logo" : "");
      badge.setAttribute("aria-hidden", "true");
      if (item.logo) { const img = document.createElement("img"); img.src = "slirc.svg"; img.alt = ""; badge.append(img); }
      else {
        badge.style.background = item.color; badge.textContent = item.letter;
        // The workspace's own icon, when an admin set one, replaces the letter once it loads.
        const icon = new Image();
        icon.alt = "";
        icon.onload = () => { badge.className = "workspace-badge logo icon"; badge.style.background = ""; badge.replaceChildren(icon); };
        icon.src = item.icon;
      }
      const main = document.createElement("span");
      main.className = "workspace-row-main";
      const name = document.createElement("strong");
      name.textContent = item.name;
      const host = document.createElement("small");
      host.textContent = item.note || item.label;
      main.append(name, host);
      // The saved workspace shows Current, as in the web dialog, in place of the chevron.
      const end = document.createElement("span");
      if (item.selected) {
        end.className = "workspace-current";
        end.textContent = "Current";
      } else {
        end.className = "workspace-row-end";
        end.setAttribute("aria-hidden", "true");
        end.innerHTML = CHEVRON;
      }
      open.append(badge, main, end);
      open.addEventListener("click", () => pick(item.origin));
      wrap.append(open);
      if (item.saved) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "workspace-remove";
        remove.tabIndex = -1;
        remove.setAttribute("aria-label", `Remove ${item.label} from this Mac`);
        remove.title = "Remove from this Mac";
        remove.innerHTML = CROSS;
        remove.addEventListener("click", () => forget(item.origin));
        wrap.append(remove);
      }
      return wrap;
    }));
  }

  function pick(typed) {
    error.textContent = "";
    busy(true);
    post({ open: typed });
  }

  function forget(origin) {
    const rows = [...list.querySelectorAll(".workspace-row")];
    const at = rows.findIndex((row) => row.dataset.origin === origin);
    workspaces = workspaces.filter((saved) => saved !== origin);
    post({ remove: origin });
    render();
    const next = list.querySelectorAll(".workspace-row");
    (next[Math.min(at, next.length - 1)] || field).focus();
  }

  window.slircPickerFailed = (message, text) => {
    busy(false);
    error.textContent = message;
    if (text) field.value = text;
    submit.disabled = !field.value.trim();
    field.focus();
    field.select();
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (field.value.trim()) pick(field.value.trim());
  });
  field.addEventListener("input", () => { error.textContent = ""; submit.disabled = !field.value.trim(); });
  leave.addEventListener("click", () => post(canGoBack() ? { cancel: true } : { quit: true }));

  // Rows, Tab and typing in the list work as in the web dialog (installWorkspaceKeys). Delete
  // removes the focused saved row, Escape goes back, and typing anywhere else goes to the field.
  globalThis.slircWorkspaceMark.installWorkspaceKeys(document.querySelector("main"), field);
  document.addEventListener("keydown", (event) => {
    const rows = [...list.querySelectorAll(".workspace-row")];
    const at = rows.indexOf(document.activeElement);
    if ((event.key === "Backspace" || event.key === "Delete") && at >= 0 && workspaces.includes(rows[at].dataset.origin)) {
      event.preventDefault();
      forget(rows[at].dataset.origin);
    } else if (event.key === "Escape" && canGoBack()) {
      post({ cancel: true });
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && document.activeElement !== field && !field.disabled) {
      field.focus();
    }
  });

  render();
  error.textContent = state.message;
  field.value = state.text;
  submit.disabled = !field.value.trim();
  const selected = list.querySelector('[aria-current="true"]');
  (!state.text && selected ? selected : workspaces.length && !state.text ? list.querySelector(".workspace-row") : field).focus();
})();

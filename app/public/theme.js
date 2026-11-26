// Runs before CSS so the boot screen and native controls use the chosen theme.
(() => {
  const key = "slirc-theme";
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const valid = (value) => ["light", "dark", "system"].includes(value) ? value : "system";
  const read = () => { try { return valid(localStorage.getItem(key)); } catch { return "system"; } };
  let preference = read();
  let accountId = "";
  // The account theme is adopted once per page load. A choice made on this page wins after that, so a
  // reconnect never undoes it, even when the save failed or is still in flight.
  let adoptedFor = "";
  function remember(value) {
    preference = valid(value);
    try { localStorage.setItem(key, preference); } catch { /* Storage may be blocked. */ }
    apply();
  }
  document.addEventListener("slirc:theme-account", (event) => {
    accountId = event.detail?.accountId || "";
    const theme = event.detail?.theme;
    if (!accountId || adoptedFor === accountId) return;
    // A different account on this page starts from its own saved theme, or System when it has none,
    // so one person's choice never carries over to the next.
    const switched = adoptedFor !== "";
    adoptedFor = accountId;
    if (["light", "dark", "system"].includes(theme)) remember(theme);
    else if (switched) remember("system");
  });
  function apply() {
    const theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#eff1f5" : "#11111b");
    document.querySelectorAll("select[data-theme-picker]").forEach((select) => { select.value = preference; });
  }
  document.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.hasAttribute("data-theme-picker")) return;
    remember(select.value);
    if (accountId) {
      fetch("/profile", {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, theme: preference }),
      }).catch(() => {}); // Failed saves keep the local choice.
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) { preference = read(); apply(); }
  });
  system.addEventListener("change", () => { if (preference === "system") apply(); });
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  apply();
})();

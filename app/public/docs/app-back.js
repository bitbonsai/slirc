// "‹ Back" bar for docs opened from the app: the iOS shell or a phone. More > Help & docs leads
// here, and without it the shell has no way back. Same shell check as welcome.js and the client's
// install banner; phones match the client's coarse-pointer test or the slirc_phone cookie.
(function () {
  "use strict";
  const bar = document.getElementById("app-back");
  if (!bar) return;
  const shell = !!window.__slircNative || !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const phone = matchMedia("(pointer: coarse) and (max-width: 879px)").matches || document.cookie.includes("slirc_phone=1");
  if (!shell && !phone) return;
  bar.hidden = false;
  document.documentElement.classList.add("docs-in-app");

  // In the shell, Back loads the app page that opened the docs (the same-origin referrer, such as
  // /agents for its "Learn more"), or the More tab when there is none, and never walks history. WebKit
  // restores the app page from its back/forward cache and reports that restore as a cancelled load
  // (NSURLErrorCancelled), and Capacitor answers any failed load with its errorPath, which sends the
  // person to the workspace picker with "couldn't reach your workspace". replace() keeps the docs
  // page out of history, so a later back can't land there either.
  // On a phone browser, a visit that came from the app goes back past every docs page swap (docs.js
  // counts them in history.state). Otherwise the link opens the app on its More tab.
  const link = bar.querySelector("a");
  let from = null;
  try { from = document.referrer ? new URL(document.referrer) : null; } catch { from = null; }
  const appPage = (url) => !!url && url.origin === location.origin && !/^\/docs(\/|$)/.test(url.pathname);
  if (shell && link) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const back = appPage(from) ? from.pathname + from.search + from.hash : new URL(link.href, location.href).pathname;
      location.replace(location.origin + back);
    });
    return;
  }
  const fromApp = !!from && !!link && from.origin === new URL(link.href, location.href).origin && !/^\/docs(\/|$)/.test(from.pathname);
  link?.addEventListener("click", (event) => {
    if (!fromApp || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.go(-((history.state && history.state.docsDepth) || 0) - 1);
  });
})();

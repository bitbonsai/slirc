// Service worker for the new client at the app root. It makes no offline-shell claim: it registers
// no fetch handler, so every request reaches the network and no legacy HTML can be replayed from a
// cache. Its only job is to keep an installable registration at scope "/" and retire the legacy
// shell cache once. IndexedDB, drafts, sessions and the durable outbox are never touched here.
const LEGACY_CACHE_PREFIX = "shell-";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil((async () => {
  // Controlled cleanup only: drop the legacy shell caches. A candidate cache, if one is ever added,
  // must use a different prefix so this does not delete it.
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith(LEGACY_CACHE_PREFIX)).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));

// A notification's link is a path on this origin, such as /#general. Anything else opens the root.
// The link is resolved rather than matched as text, because the URL parser reads "\" as "/", so
// "/\evil.example" would otherwise leave the origin.
function ownPath(value) {
  if (typeof value !== "string") return "/";
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

// Notifications still require an explicit user subscription. A push also marks the installed app's
// icon. The worker cannot count unread messages, so the mark is a dot until the page opens and sets
// the real count.
self.addEventListener("push", (event) => {
  const data = event.data?.json() || { title: "Slirc", body: "New message" };
  const badge = Promise.resolve(self.navigator?.setAppBadge?.()).catch(() => {});
  event.waitUntil(Promise.all([self.registration.showNotification(data.title, { body: data.body, tag: data.tag, data: { url: ownPath(data.url) } }), badge]));
});

// Tapping a notification opens its conversation, in the window that is already open if there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = ownPath(event.notification.data?.url);
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const open = windows[0];
    if (!open) return clients.openWindow(url);
    await open.focus();
    if (url !== "/") await Promise.resolve(open.navigate?.(url)).catch(() => {});
  }));
});

const names = new Set(["star", "user", "copy", "link", "user-plus", "mail", "pencil", "archive", "lock", "log-out", "trash", "quote", "reply", "corner-down-right", "settings", "check", "home", "message-circle", "bell", "bell-off", "ellipsis", "eye-off", "hash", "bot", "smartphone", "info", "chevron-right", "chevron-down", "x", "maximize", "minimize", "smile-plus", "external-link", "user-star", "circle-alert", "terminal"]);

export function lucide(name) {
  if (!names.has(name)) return "";
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons/lucide/sprite.svg?v=14#${name}"></use></svg>`;
}

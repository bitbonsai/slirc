// Server-to-client events for signed-in people, one SSE stream per browser tab.
// ponytail: in-memory registry fits one app process; a second instance would need a shared bus.
type Send = (event: string, data: unknown) => void;

const listeners = new Map<string, Set<Send>>();

export function subscribe(nick: string, send: Send) {
  const key = nick.toLowerCase();
  const set = listeners.get(key) ?? new Set<Send>();
  set.add(send);
  listeners.set(key, set);
  return () => {
    set.delete(send);
    if (!set.size) listeners.delete(key);
  };
}

export function publish(nick: string, event: string, data: unknown) {
  const set = listeners.get(nick.toLowerCase());
  if (!set) return;
  for (const send of [...set]) {
    try {
      send(event, data);
    } catch {}
  }
}

// Everyone signed in who passes `include`, such as the members of one channel.
export function publishWhere(include: (nick: string) => boolean, event: string, data: unknown) {
  for (const nick of [...listeners.keys()]) if (include(nick)) publish(nick, event, data);
}

// A channel joined or left these people's lists. Each of their tabs re-reads /auth/me unless it
// already agrees, so a channel made on the phone shows on the desktop without a reload.
// `deleted` marks a channel that is gone for good, so a tab showing it can move on with a notice.
export function channelsChanged(channel: string, nicks: Iterable<string>, member: boolean, extra: { deleted?: true } = {}) {
  for (const nick of new Set([...nicks].map((nick) => nick.toLowerCase()))) publish(nick, "channels", { channel, member, ...extra });
}

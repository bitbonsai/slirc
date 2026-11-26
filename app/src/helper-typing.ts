// "help is typing…" while a helper works, sent the way a person's client does it: IRCv3 `+typing`
// on a TAGMSG to the room or DM the reply goes to. The first `active` waits a beat so an instant
// reply shows nothing, refreshes inside the 6s receiver expiry, and `done` always ends a shown span,
// even when the work throws. Two handlers in one target share a span, and `active` never goes out
// more than once per refresh window per target, which keeps the lines well inside Ergo's fakelag.
// Model calls carry their own timeouts; the cap is a backstop so a hung handler cannot type forever.
export const TYPING_DELAY_MS = 300;
export const TYPING_REFRESH_MS = 3_000;
export const TYPING_MAX_MS = 60_000;

type Span = { target: string; workers: number; shown: boolean; start?: ReturnType<typeof setTimeout>; refresh?: ReturnType<typeof setInterval>; cap?: ReturnType<typeof setTimeout> };

export function createHelperTyping(send: (line: string) => boolean, { delayMs = TYPING_DELAY_MS, refreshMs = TYPING_REFRESH_MS, maxMs = TYPING_MAX_MS, now = () => Date.now() } = {}) {
  const spans = new Map<string, Span>();
  // When each target last got `active`, so a span right after another one still waits out the window.
  const lastActive = new Map<string, number>();

  const active = (key: string, target: string) => {
    lastActive.set(key, now());
    return send(`@+typing=active TAGMSG ${target}`);
  };

  const stop = (span: Span) => {
    clearTimeout(span.start);
    clearInterval(span.refresh);
    clearTimeout(span.cap);
    if (span.shown) send(`@+typing=done TAGMSG ${span.target}`);
    span.shown = false;
  };

  return async function withTyping<T>(target: string, work: () => Promise<T> | T): Promise<T> {
    const key = target.toLowerCase();
    let span = spans.get(key);
    if (!span) {
      const at = now();
      for (const [other, sent] of lastActive) if (at - sent >= refreshMs) lastActive.delete(other);
      const created: Span = { target, workers: 0, shown: false };
      const wait = Math.max(delayMs, (lastActive.get(key) ?? -Infinity) + refreshMs - at);
      // A line refused by a closed socket shows nothing, so only a sent one needs a `done`.
      const beat = () => { if (active(key, target)) created.shown = true; };
      created.start = setTimeout(() => {
        beat();
        created.refresh = setInterval(beat, refreshMs);
      }, wait);
      created.cap = setTimeout(() => stop(created), maxMs);
      spans.set(key, span = created);
    }
    span.workers++;
    try {
      return await work();
    } finally {
      if (--span.workers === 0) {
        spans.delete(key);
        stop(span);
      }
    }
  };
}

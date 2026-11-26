// While the socket is connecting, the chat dims so a slow connection reads as connecting, not
// broken. Input stays live: the outbox queues what people type (instant.md rule 2). A blip shorter
// than the delay never dims; connecting clears it at once.
export const CONNECTING_DIM_DELAY_MS = 300;

export function createConnectingDim(apply: (on: boolean) => void, delayMs = CONNECTING_DIM_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let on = false;

  return {
    set(connecting: boolean): void {
      if (connecting) {
        if (on || timer !== null) return;
        timer = setTimeout(() => { timer = null; on = true; apply(true); }, delayMs);
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (on) { on = false; apply(false); }
    },
  };
}

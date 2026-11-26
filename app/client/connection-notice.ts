// A dropped attempt is normal on a phone: the PWA opens or resumes before the network is back, and
// the first retries fail too. The first failure starts a grace period; further failures inside it
// stay quiet, and only the grace running out without a connection shows the error. The grace spans
// the first two reconnect rounds (2s, then 4s later) plus time to connect. Connecting clears it.
export const CONNECTION_ERROR = "Could not reach the server. Retrying…";

export interface ConnectionNoticeOptions {
  show: (text: string) => void;
  clear: () => void;
  graceMs?: number;
}

export function createConnectionNotice({ show, clear, graceMs = 10_000 }: ConnectionNoticeOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;

  function cancel(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return {
    failed(): void {
      if (shown || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        shown = true;
        show(CONNECTION_ERROR);
      }, graceMs);
    },
    reset(): void {
      cancel();
      shown = false;
      clear();
    },
  };
}

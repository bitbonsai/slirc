
export function pairRequestUrl(origin: string, code: string): string {
  return new URL(`/pair/${encodeURIComponent(code)}`, origin).href;
}

export function normalizePairCode(value: string): string | null {
  const code = value.replace(/\D/g, "");
  return code.length === 6 ? code : null;
}

export function isPairCodeComplete(value: unknown): boolean {
  return normalizePairCode(typeof value === "string" ? value : "") !== null;
}

export function validSignInEmail(value: unknown): boolean {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function editPairCode(value: string, index: number, input: string): { value: string; focus: number } {
  const digits = input.replace(/\D/g, "");
  if (index < 0 || index > 5 || digits.length > 6) return { value, focus: Math.max(0, Math.min(5, index)) };
  if (input && !digits) return { value, focus: index };
  const slots = value.padEnd(6, " ").slice(0, 6).split("");
  const start = digits.length === 6 ? 0 : index;
  if (!digits) slots[index] = " ";
  else for (let i = 0; i < digits.length && start + i < 6; i++) slots[start + i] = digits[i]!;
  return { value: slots.join("").trimEnd(), focus: Math.min(5, start + digits.length) };
}

export function pairDigitInput(inputType: string, data: string | null | undefined, fieldValue: string): string {
  return inputType === "insertText" && typeof data === "string" && /^\d$/.test(data) ? data : fieldValue;
}

export function pairRequestSummary(request: unknown, account: string): string {
  const req = request as { browser?: unknown; os?: unknown } | null;
  const browser = typeof req?.browser === "string" && req.browser.trim() ? req.browser.trim() : "another browser";
  const os = typeof req?.os === "string" && req.os.trim() ? req.os.trim() : "an unknown system";
  return `A device using ${browser} on ${os} wants to sign in as @${account}.`;
}

export function formatPairCode(value: unknown): string {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : "";
}

export function pairDeliveryUrl(code: string, token: string): string {
  return `/api/pair/${encodeURIComponent(code)}/session?token=${encodeURIComponent(token)}`;
}

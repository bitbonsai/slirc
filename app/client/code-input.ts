// Codes arrive pasted from mail and terminals as "320 245", " 320245 " or "abcd efgh". `x-code`
// cleans them on paste and on input, so maxlength never cuts a pasted code before it is cleaned:
// code fields carry no maxlength and the cap applies after cleaning.
//   x-code="digits"  six-digit codes (sign-in, invitation, device pairing)
//   x-code="agent"   XXXX-XXXX agent connect codes
//   x-code="trim"    emails and addresses: a paste loses its outer whitespace
export type CodeFormat = "digits" | "agent" | "trim";

const fullLength = { digits: 6, agent: 8 } as const;

export function cleanCode(value: string, format: CodeFormat): string {
  if (format === "trim") return value.trim();
  if (format === "digits") return value.replace(/\D/g, "").slice(0, 6);
  const chars = value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
}

// A pasted whole code replaces whatever the field held; a partial paste goes in at the caret.
export function pasteCode(current: string, start: number, end: number, text: string, format: CodeFormat): string {
  if (format === "trim") return current.slice(0, start) + text.trim() + current.slice(end);
  const pasted = cleanCode(text, format);
  if (pasted.replace(/-/g, "").length === fullLength[format]) return pasted;
  return cleanCode(current.slice(0, start) + text + current.slice(end), format);
}

export function codeDirective(
  el: HTMLInputElement,
  { expression }: { expression: string },
  { cleanup }: { cleanup: (callback: () => void) => void },
): void {
  const format = (expression.trim() || "digits") as CodeFormat;
  const commit = (value: string): void => {
    if (el.value === value) return;
    el.value = value;
    // x-model and any x-on:input read the cleaned value.
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const paste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text");
    // type="email" has no selection API; the browser pastes and the input handler trims.
    if (typeof text !== "string" || el.selectionStart === null) return;
    event.preventDefault();
    commit(pasteCode(el.value, el.selectionStart, el.selectionEnd ?? el.selectionStart, text, format));
  };
  const input = (event: Event): void => {
    const kind = (event as InputEvent).inputType || "";
    if (format !== "trim" || kind === "insertFromPaste" || kind === "insertFromDrop" || kind === "insertReplacementText") commit(cleanCode(el.value, format));
  };
  el.addEventListener("paste", paste);
  el.addEventListener("input", input);
  cleanup(() => {
    el.removeEventListener("paste", paste);
    el.removeEventListener("input", input);
  });
}

// x-code cleans pasted and typed one-time codes before maxlength or x-model can see a stray space.
import { expect, test } from "bun:test";
import { cleanCode, codeDirective, pasteCode } from "@client/code-input.ts";

test("six-digit codes keep only digits, capped after cleaning", () => {
  expect(cleanCode("320 245", "digits")).toBe("320245");
  expect(cleanCode(" 320245 ", "digits")).toBe("320245");
  expect(cleanCode("320-245", "digits")).toBe("320245");
  expect(cleanCode("320 245 9", "digits")).toBe("320245");
});

test("agent codes come out as XXXX-XXXX", () => {
  expect(cleanCode(" abcd efgh ", "agent")).toBe("ABCD-EFGH");
  expect(cleanCode("ABCD - EFGH", "agent")).toBe("ABCD-EFGH");
  expect(cleanCode("abc", "agent")).toBe("ABC");
  expect(cleanCode("ABCD-", "agent")).toBe("ABCD");
  expect(cleanCode("abcde", "agent")).toBe("ABCD-E");
});

test("a pasted whole code replaces the field; a partial paste goes in at the caret", () => {
  expect(pasteCode("", 0, 0, "320 245", "digits")).toBe("320245");
  expect(pasteCode("12", 2, 2, " 320245 ", "digits")).toBe("320245");
  expect(pasteCode("12", 2, 2, "3 4", "digits")).toBe("1234");
  expect(pasteCode("AB", 2, 2, "abcd efgh", "agent")).toBe("ABCD-EFGH");
  expect(pasteCode("", 0, 0, "  ada@example.com\n", "trim")).toBe("ada@example.com");
});

function field(value = "") {
  const el = new EventTarget() as EventTarget & { value: string; selectionStart: number | null; selectionEnd: number | null };
  el.value = value; el.selectionStart = value.length; el.selectionEnd = value.length;
  const seen: string[] = [];
  el.addEventListener("input", () => seen.push(el.value));
  return { el, seen };
}
const pasteEvent = (text: string) => Object.assign(new Event("paste", { cancelable: true }), { clipboardData: { getData: () => text } });
const inputEvent = (inputType: string) => Object.assign(new Event("input"), { inputType });

test("the directive cleans a paste before x-model reads it, then cleans typing", () => {
  const { el, seen } = field();
  codeDirective(el as any, { expression: "digits" }, { cleanup: () => {} });
  const paste = pasteEvent("320 245");
  el.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);
  expect(el.value).toBe("320245");
  expect(seen.at(-1)).toBe("320245");
  el.value = "12 3";
  el.dispatchEvent(inputEvent("insertText"));
  expect(el.value).toBe("123");
});

test("trim fields keep typed spaces but lose them around a paste", () => {
  const { el } = field();
  codeDirective(el as any, { expression: "trim" }, { cleanup: () => {} });
  el.value = "ada ";
  el.dispatchEvent(inputEvent("insertText"));
  expect(el.value).toBe("ada ");
  el.value = " ada@example.com ";
  el.dispatchEvent(inputEvent("insertFromPaste"));
  expect(el.value).toBe("ada@example.com");
});

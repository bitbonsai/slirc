import { expect, test } from "bun:test";
import { reactionLine } from "../public/reactions.js";

test("reaction lines carry current and draft reply tags", () => {
  expect(reactionLine("#room", "a b;c", "👍")).toBe("@+reply=a\\sb\\:c;+draft/reply=a\\sb\\:c;+draft/react=👍 TAGMSG #room");
  expect(reactionLine("#room", "m1", "👍", true)).toBe("@+reply=m1;+draft/reply=m1;+draft/unreact=👍 TAGMSG #room");
  expect(() => reactionLine("#room\r\nPRIVMSG #other", "m1", "👍")).toThrow("invalid reaction target");
});

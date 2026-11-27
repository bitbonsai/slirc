// Long lines inside a multiline message. Ergo drops any line over 512 bytes (tags aside, CRLF
// included) and keeps the rest of the batch, so a pasted long line used to vanish from the message.
// Senders now cut it into draft/multiline-concat parts and readers join them back.
import { expect, test } from "bun:test";
import type { Operation } from "@client/model.ts";
import { serializeOperation } from "@client/protocol.ts";
import { eventsFromBatch } from "@client/sync.ts";
import { joinParts, wireParts } from "../shared/multiline.ts";

const wireBytes = (line: string) => new TextEncoder().encode(line.replace(/^@\S+ /, "")).length + 2;

test("wire parts fit Ergo's line, keep blank lines, never split a character, and join back exactly", () => {
  const target = "#dm-13caae5e514de9efd3c0b91757249879c0f203fe2ce59f51eaadf863";
  const long = "😀é".repeat(160); // 960 bytes of 4- and 2-byte characters
  const text = `First\n\n${long}\nLast`;
  const parts = wireParts(text, target);
  for (const part of parts) expect(wireBytes(`PRIVMSG ${target} :${part.text}`)).toBeLessThanOrEqual(512);
  expect(parts.filter((part) => !part.concat).map((part) => part.text)).toEqual(["First", "", long.slice(0, parts[2].text.length), "Last"]);
  expect(parts.some((part) => part.concat && part.text === "")).toBe(false);
  expect(joinParts(parts)).toBe(text);
  expect(wireParts("short", "#r")).toEqual([{ text: "short", concat: false }]);
});

test("a person's multiline message with a 600-character line goes out as concat parts that each fit", () => {
  const long = "a".repeat(600);
  const operation = { id: "op1", messageId: "m1", conversationId: "c", kind: "text", text: `Intro\n${long}`, state: "queued", createdAt: 1 } as unknown as Operation;
  const lines = serializeOperation(operation, "#ai-guild", true, () => "B1");
  expect(lines[0]).toBe("@+slirc/cid=op1 BATCH +B1 draft/multiline #ai-guild");
  expect(lines.at(-1)).toBe("BATCH -B1");
  const privmsgs = lines.slice(1, -1);
  expect(privmsgs[0]).toBe("@batch=B1 PRIVMSG #ai-guild :Intro");
  expect(privmsgs.length).toBe(3);
  expect(privmsgs[1].startsWith("@batch=B1 PRIVMSG #ai-guild :")).toBe(true);
  expect(privmsgs[2].startsWith("@batch=B1;draft/multiline-concat PRIVMSG #ai-guild :")).toBe(true);
  for (const line of privmsgs) expect(wireBytes(line)).toBeLessThanOrEqual(512);
  expect(privmsgs.slice(1).map((line) => line.slice(line.indexOf(" :") + 2)).join("")).toBe(long);
});

test("a received multiline batch joins concat parts without a newline, live and from history", () => {
  const line = (text: string, concat = false) => ({ kind: "line" as const, message: {
    tags: { batch: "ml", ...(concat ? { "draft/multiline-concat": "" } : {}) }, prefix: "pi-b072!u@h", command: "PRIVMSG", params: ["#ai-guild", text],
  } });
  const multiline = { id: "ml", type: "draft/multiline", params: ["#ai-guild"], tags: { msgid: "srv-1", "+slirc/cid": "cid-1", time: "2026-11-17T15:16:53.000Z" }, complete: true,
    items: [line("Summary"), line(""), line("first half "), line("second half", true), line("Last")] };
  const live = eventsFromBatch("room", multiline as any) as { message: { text: string } }[];
  expect(live[0].message.text).toBe("Summary\n\nfirst half second half\nLast");
  const history = eventsFromBatch("room", { id: "h", type: "chathistory", params: ["#ai-guild"], tags: {}, complete: true, items: [{ kind: "batch", batch: multiline }] } as any) as { message: { text: string } }[];
  expect(history[0].message.text).toBe("Summary\n\nfirst half second half\nLast");
});

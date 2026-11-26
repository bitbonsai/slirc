// Helper typing spans: delayed first active, refresh while working, done on success, error and the
// backstop cap, one shared span per target, and the per-target active window across spans.
import { expect, test } from "bun:test";
import { createHelperTyping } from "../src/helper-typing.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timing = { delayMs: 20, refreshMs: 60, maxMs: 5_000 };

function make(options: Partial<typeof timing> = {}) {
  const sent: string[] = [];
  const withTyping = createHelperTyping((line) => { sent.push(line); return true; }, { ...timing, ...options });
  return { sent, withTyping };
}

test("a slow handler types, refreshes, then sends done after its reply", async () => {
  const { sent, withTyping } = make();
  const result = await withTyping("#dm-help-ana", async () => {
    await wait(150);
    sent.push("PRIVMSG #dm-help-ana :answer");
    return 42;
  });
  expect(result).toBe(42);
  const actives = sent.filter((line) => line === "@+typing=active TAGMSG #dm-help-ana").length;
  expect(actives).toBeGreaterThanOrEqual(2);
  expect(sent[0]).toBe("@+typing=active TAGMSG #dm-help-ana");
  expect(sent.at(-2)).toBe("PRIVMSG #dm-help-ana :answer");
  expect(sent.at(-1)).toBe("@+typing=done TAGMSG #dm-help-ana");
  await wait(100);
  expect(sent.at(-1)).toBe("@+typing=done TAGMSG #dm-help-ana");
});

test("a throwing handler still ends with done and rethrows", async () => {
  const { sent, withTyping } = make();
  await expect(withTyping("#help", async () => { await wait(50); throw new Error("model down"); })).rejects.toThrow("model down");
  expect(sent).toEqual(["@+typing=active TAGMSG #help", "@+typing=done TAGMSG #help"]);
  await wait(100);
  expect(sent.length).toBe(2);
});

test("an instant handler sends no typing at all", async () => {
  const { sent, withTyping } = make();
  await withTyping("#room", () => { sent.push("PRIVMSG #room :Counted: pizza"); });
  await wait(80);
  expect(sent).toEqual(["PRIVMSG #room :Counted: pizza"]);
});

test("two handlers in one target share a span and done waits for the last", async () => {
  const { sent, withTyping } = make();
  const first = withTyping("#help", () => wait(40));
  const second = withTyping("#HELP", () => wait(100));
  await first;
  expect(sent).toEqual(["@+typing=active TAGMSG #help"]);
  await second;
  expect(sent.filter((line) => line.includes("active")).length).toBe(2);
  expect(sent.at(-1)).toBe("@+typing=done TAGMSG #help");
  expect(sent.filter((line) => line.includes("done")).length).toBe(1);
});

test("a span right after another waits out the refresh window before its active", async () => {
  const { sent, withTyping } = make({ refreshMs: 200 });
  await withTyping("#room", () => wait(40));
  const started = Date.now();
  await withTyping("#room", () => wait(80));
  expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  // The second span ended before 200ms had passed since the first active, so it never showed.
  expect(sent).toEqual(["@+typing=active TAGMSG #room", "@+typing=done TAGMSG #room"]);
});

test("the cap ends a hung handler's typing without waiting for it", async () => {
  const { sent, withTyping } = make({ maxMs: 100 });
  const hung = withTyping("#help", () => wait(250));
  await wait(150);
  expect(sent.at(-1)).toBe("@+typing=done TAGMSG #help");
  const count = sent.length;
  await hung;
  expect(sent.length).toBe(count);
});

test("a refused send never needs a done", async () => {
  const sent: string[] = [];
  const withTyping = createHelperTyping((line) => { sent.push(line); return false; }, timing);
  await withTyping("#help", () => wait(50));
  expect(sent).toEqual(["@+typing=active TAGMSG #help"]);
});

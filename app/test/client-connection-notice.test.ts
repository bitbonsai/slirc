import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { CONNECTION_ERROR, createConnectionNotice } from "@client/connection-notice.ts";

describe("connection notice", () => {
  let shown: string;
  let notice: ReturnType<typeof createConnectionNotice>;

  beforeEach(() => {
    jest.useFakeTimers();
    shown = "";
    notice = createConnectionNotice({ show: (text) => { shown = text; }, clear: () => { shown = ""; } });
  });
  afterEach(() => { jest.useRealTimers(); });

  test("a first failure followed by a connection never shows the error", () => {
    notice.failed();
    jest.advanceTimersByTime(2_000);
    notice.reset();
    jest.advanceTimersByTime(20_000);
    expect(shown).toBe("");
  });

  // Cold start or resume on a phone: the first attempt and its retries at 2s and 6s fail while the
  // network wakes up, then the next try connects. Nothing error-like shows on the way.
  test("failed retries inside the grace period stay quiet until a connection", () => {
    notice.failed();
    jest.advanceTimersByTime(2_000);
    notice.failed();
    jest.advanceTimersByTime(4_000);
    notice.failed();
    expect(shown).toBe("");
    jest.advanceTimersByTime(3_000);
    notice.reset();
    jest.advanceTimersByTime(20_000);
    expect(shown).toBe("");
  });

  test("the grace period running out without a connection shows the error", () => {
    notice.failed();
    notice.failed();
    jest.advanceTimersByTime(9_999);
    expect(shown).toBe("");
    jest.advanceTimersByTime(1);
    expect(shown).toBe(CONNECTION_ERROR);
  });

  test("failures after the error is shown keep it without restarting the grace", () => {
    notice.failed();
    jest.advanceTimersByTime(10_000);
    notice.failed();
    expect(shown).toBe(CONNECTION_ERROR);
  });

  test("connecting clears a shown error and restores the grace for the next drop", () => {
    notice.failed();
    jest.advanceTimersByTime(10_000);
    notice.reset();
    expect(shown).toBe("");
    notice.failed();
    notice.failed();
    jest.advanceTimersByTime(9_999);
    expect(shown).toBe("");
  });
});

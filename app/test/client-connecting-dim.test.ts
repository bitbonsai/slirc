import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createConnectingDim } from "@client/connecting-dim.ts";

describe("connecting dim", () => {
  let calls: boolean[];
  let dim: ReturnType<typeof createConnectingDim>;

  beforeEach(() => {
    jest.useFakeTimers();
    calls = [];
    dim = createConnectingDim((on) => { calls.push(on); });
  });
  afterEach(() => { jest.useRealTimers(); });

  test("a blip shorter than the delay never dims", () => {
    dim.set(true);
    jest.advanceTimersByTime(250);
    dim.set(false);
    jest.advanceTimersByTime(1_000);
    expect(calls).toEqual([]);
  });

  test("dims after the delay and clears once connected", () => {
    dim.set(true);
    jest.advanceTimersByTime(299);
    expect(calls).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(calls).toEqual([true]);
    dim.set(true);
    jest.advanceTimersByTime(1_000);
    dim.set(false);
    dim.set(false);
    expect(calls).toEqual([true, false]);
  });
});

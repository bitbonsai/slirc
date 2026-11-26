import { expect, test } from "bun:test";
import { animatePhoneScreen, phoneScreenDirection } from "@client/presentation.ts";

test("phone direction follows tab order, detail entry, and return navigation", () => {
  expect(phoneScreenDirection("home", { kind: "tab", tab: "dms" }, false)).toBe(1);
  expect(phoneScreenDirection("more", { kind: "tab", tab: "home" }, false)).toBe(-1);
  expect(phoneScreenDirection("dms", { kind: "tab", tab: "home" }, false)).toBe(-1);
  expect(phoneScreenDirection("more", { kind: "profile" }, false)).toBe(1);
  expect(phoneScreenDirection(null, { kind: "tab", tab: "more" }, false)).toBe(-1);
  expect(phoneScreenDirection(null, { kind: "profile" }, true)).toBe(-1);
});

test("the horizontal fade is held at frame zero before display, avoiding an opaque flash", () => {
  const calls: unknown[][] = [], animations: { paused: boolean; currentTime: number | null }[] = [];
  const screen = { animate: (...args: unknown[]) => {
    calls.push(args);
    const animation = { paused: false, currentTime: null as number | null, pause() { this.paused = true; } };
    animations.push(animation);
    return animation;
  } } as unknown as HTMLElement;
  animatePhoneScreen(screen, false, 1);
  animatePhoneScreen(screen, false, -1);
  // Each run starts invisible, so nothing paints at full opacity before the first frame.
  expect(calls.map((args) => (args[0] as Keyframe[])[0]!.opacity)).toEqual([0, 0]);
  expect(animations.every((animation) => animation.paused && animation.currentTime === 0)).toBe(true);
  expect(animatePhoneScreen(screen, true)).toBeNull();
  expect(animatePhoneScreen(null, false)).toBeNull();
  expect(animatePhoneScreen({} as HTMLElement, false)).toBeNull();
  expect(calls).toHaveLength(2);
});

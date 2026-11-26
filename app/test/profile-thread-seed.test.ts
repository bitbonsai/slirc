import { expect, test } from "bun:test";
import {
  profileThreadSeedGuard,
  threadStamp,
} from "../scripts/profile-thread-fixtures.ts";

test("sample thread seed requires both the explicit opt-in and the isolated profile", () => {
  expect(profileThreadSeedGuard({})).toEqual({ ok: false, reason: "Sample thread seed requires the explicit opt-in SLIRC_PROFILE_THREAD_SEED=true" });
  expect(profileThreadSeedGuard({ SLIRC_PROFILE_THREAD_SEED: "true" }).ok).toBe(false);
  expect(profileThreadSeedGuard({ SLIRC_PROFILE_THREAD_SEED: "1", SLIRC_DEV_PROFILE: "slirc2" }).ok).toBe(false);
  expect(profileThreadSeedGuard({ SLIRC_PROFILE_THREAD_SEED: "true", SLIRC_DEV_PROFILE: "beta" }).ok).toBe(false);
  expect(profileThreadSeedGuard({ SLIRC_PROFILE_THREAD_SEED: "true", SLIRC_DEV_PROFILE: "slirc2" }).ok).toBe(true);
});

test("thread stamp is per write kind, sender and index", () => {
  expect(threadStamp("reply", "eve", 2)).toBe(threadStamp("reply", "eve", 2));
  expect(threadStamp("reply", "eve", 2)).not.toBe(threadStamp("reply", "eve", 3));
  expect(threadStamp("reply", "eve", 0)).not.toBe(threadStamp("root", "eve", 0));
  expect(threadStamp("reply", "eve", 0)).not.toBe(threadStamp("reply", "bo", 0));
});

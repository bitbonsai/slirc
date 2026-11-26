import { canonicalHarness } from "../../../shared/harnesses.ts";
import type { Harness } from "./types.ts";
import pi from "./pi/module.ts";
import claude from "./claude/module.ts";
import codex from "./codex/module.ts";
import opencode from "./opencode/module.ts";

// Every harness Slirc knows. Order is the picker order. Add a module here and nowhere else.
export const harnesses: Harness[] = [pi, claude, codex, opencode];

export { canonicalHarness };

export const releasedHarnesses = () => harnesses.filter((harness) => harness.released);
export const harnessById = (id: string) => harnesses.find((harness) => harness.id === canonicalHarness(id));
export type { Harness } from "./types.ts";

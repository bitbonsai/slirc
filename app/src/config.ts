import { HELPER_NICKS, OPT_IN_HELPERS } from "../shared/service-bots.ts";

// Deployment mode. Hosted and self-hosted instances run the same code with the same keys;
// the mode comes from configuration, never from the request host or a feature entitlement.
export type SlircMode = "private_workspace" | "public_playground";

// Unset means private_workspace: a private instance is the safe default, and an explicit
// value must name a mode exactly so a typo cannot quietly widen a private instance.
export function slircMode(): SlircMode {
  const raw = process.env.SLIRC_MODE;
  if (raw === undefined) return "private_workspace";
  const mode = raw.trim();
  if (mode === "private_workspace" || mode === "public_playground") return mode;
  throw new Error(`SLIRC_MODE must be private_workspace or public_playground, got "${raw}"`);
}

// Which Slirc wordmark an instance shows. Self-hosted instances default to the neutral slirc.org
// mark ("org"); hosted workspaces set SLIRC_BRAND=slirc.app ("app"). Files: /brand-<kind>-<dark|light>.svg.
export type BrandKind = "org" | "app";
export function brandKind(): BrandKind {
  const raw = process.env.SLIRC_BRAND;
  if (raw === undefined) return "org";
  const brand = raw.trim().toLowerCase();
  if (brand === "slirc.app" || brand === "app") return "app";
  if (brand === "slirc.org" || brand === "org") return "org";
  throw new Error(`SLIRC_BRAND must be slirc.org, org, slirc.app, or app, got "${raw}"`);
}

export function configuredOwnerNick(env: NodeJS.ProcessEnv = process.env): string {
  const nick = (env.OWNER_NICK || env.ADMIN_NICK || "").trim().toLowerCase();
  if (!nick) throw new Error("OWNER_NICK required");
  return nick;
}

// Open channels are explicit configuration, normalized as before (trim, lowercase, drop blanks).
// A private workspace has none and refuses a leftover public list instead of ignoring it, so a
// stale OPEN_CHANNELS cannot silently turn into public rooms.
export function configuredOpenChannels(raw: string | undefined, mode: SlircMode = slircMode()): string[] {
  const channels = (raw || "").split(",").map((channel) => channel.trim().toLowerCase()).filter(Boolean);
  if (mode === "private_workspace" && channels.length) {
    throw new Error(`OPEN_CHANNELS must be empty in private_workspace mode, got ${channels.join(",")}`);
  }
  return channels;
}

// Total bytes custom emoji may use on this instance. Unset or blank means 100 MB; anything
// else must be a positive whole number of bytes, so a typo cannot quietly lift the budget.
export const DEFAULT_EMOJI_BUDGET_BYTES = 100 * 1024 * 1024;
export function emojiBudgetBytes(): number {
  const raw = (process.env.SLIRC_EMOJI_BUDGET_BYTES || "").trim();
  if (!raw) return DEFAULT_EMOJI_BUDGET_BYTES;
  const bytes = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(`SLIRC_EMOJI_BUDGET_BYTES must be a positive whole number of bytes, got "${process.env.SLIRC_EMOJI_BUDGET_BYTES}"`);
  }
  return bytes;
}

// Paid model calls the help and remind bots make for one account in a rolling 24 hours, both bots
// together. Unset or blank means 100; anything else must be a positive whole number.
export const DEFAULT_HELPER_DAILY_LIMIT = 100;
export function helperDailyLimit(): number {
  const raw = (process.env.SLIRC_HELPER_DAILY_LIMIT || "").trim();
  if (!raw) return DEFAULT_HELPER_DAILY_LIMIT;
  const limit = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`SLIRC_HELPER_DAILY_LIMIT must be a positive whole number, got "${process.env.SLIRC_HELPER_DAILY_LIMIT}"`);
  }
  return limit;
}

// HTTPS dev links require the explicitly isolated profile, never a request Host header.
export function localDevLinks(): boolean {
  const origin = process.env.APP_ORIGIN || "";
  return process.env.MAGIC_LINK_LOG === "true" && (origin.startsWith("http://")
    || (origin.startsWith("https://") && process.env.SLIRC_DEV_PROFILE === "slirc2"));
}

export function ergoOperUser(): string {
  const user = process.env.ERGO_OPER_USER?.trim();
  if (!user) throw new Error("ERGO_OPER_USER required");
  return user;
}

// Helpers this instance runs. SLIRC_HELPERS is a comma list of helper nicks; unset or blank means
// all of them except the opt-in ones (links), so an existing instance keeps the helpers it had. SLIRC_HELPERS_ENABLED=false still means
// none. An unknown name throws, so a typo cannot quietly drop a helper.
export function enabledHelpers(): string[] {
  if (process.env.SLIRC_HELPERS_ENABLED === "false") return [];
  const raw = (process.env.SLIRC_HELPERS || "").trim();
  if (!raw) return HELPER_NICKS.filter((nick) => !OPT_IN_HELPERS.includes(nick));
  const names = raw.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((name) => !(HELPER_NICKS as readonly string[]).includes(name));
  if (unknown.length) throw new Error(`SLIRC_HELPERS names unknown helpers: ${unknown.join(",")}. Known: ${HELPER_NICKS.join(",")}`);
  return HELPER_NICKS.filter((nick) => names.includes(nick));
}

// A helper nick this instance does not run. Its account may survive from an earlier boot, so
// lookups treat it as missing instead of offering a helper that never answers.
export function inactiveHelper(nick: string | null | undefined): boolean {
  const key = (nick || "").toLowerCase();
  return (HELPER_NICKS as readonly string[]).includes(key) && !enabledHelpers().includes(key);
}

// Helpers every verified member can find in Contacts and New DM. poll and welcome act only in
// channels, so they stay out.
export function contactHelpers(): string[] {
  return enabledHelpers().filter((nick) => nick === "help" || nick === "remind");
}

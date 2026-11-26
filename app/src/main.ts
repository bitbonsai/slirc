import "./server.ts";
import { startSlircBot } from "./slirc-bot.ts";
import { ensureHelperAccounts, retireAmbientAccounts, startHelpers } from "./helper-bot.ts";
import { brandKind, configuredOwnerNick, enabledHelpers, ergoOperUser } from "./config.ts";
import { configuredAppOrigin } from "./request-security.ts";
import { ensureLinksHome } from "./links-collect.ts";
import { ensureDigestChannel } from "./links-digest.ts";
import { startImageBackfill } from "./links-images.ts";
import { backfillAdminOps } from "./admin-ops.ts";

configuredOwnerNick();
configuredAppOrigin();
brandKind();
ergoOperUser();
// A typo in SLIRC_HELPERS stops the boot here instead of quietly dropping a helper.
const helpers = enabledHelpers();

// PUSHBOT_ENABLED is the pre-rename name; keep honouring it for local scripts.
const disabled = process.env.SLIRC_BOT_ENABLED === "false" || process.env.PUSHBOT_ENABLED === "false";
if (!disabled) startSlircBot();

// Room helpers answer only in rooms someone invited them to; `welcome` sits in the public room.
if (helpers.length) {
  // A helper without an account stays offline; never let that stop the app from starting.
  await ensureHelperAccounts().catch((error) => console.error("helper accounts:", error));
  // The links helper needs its home channel before it connects, so it joins on the first sync.
  await ensureLinksHome().catch((error) => console.error("links home channel:", error instanceof Error ? error.message : error));
  if (helpers.includes("links")) await ensureDigestChannel().catch((error) => console.error("links digest channel:", error instanceof Error ? error.message : error));
  startHelpers();
  // Preview images for links that have none yet, a few at a time.
  startImageBackfill();
}

// The scripted ambient accounts are gone; an instance that still has them drops them here.
await retireAmbientAccounts().catch((error) => console.error("ambient accounts:", error));

// Admins are channel operators in every channel and thread (DMs and groups aside). Channels made
// before this, or whose grant failed, catch up here; a repeat run changes nothing. Runs in the
// background so a slow or unreachable Ergo never holds up the boot.
void backfillAdminOps()
  .then(({ channels, failed, firstError }) => { if (failed) console.error(`admin ops backfill: ${failed} of ${channels} channels failed, first ${firstError}`); })
  .catch((error) => console.error("admin ops backfill:", error instanceof Error ? error.message : error));

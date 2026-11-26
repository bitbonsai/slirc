// Local fixture only. Check before importing modules that open or change the database.
const origin = process.env.APP_ORIGIN || "";
const localOrigin = origin.startsWith("http://") || (process.env.SLIRC_DEV_PROFILE === "slirc2" && origin.startsWith("https://"));
if (process.env.SLIRC_DEV_PROFILE !== "slirc2" || !localOrigin) {
  throw new Error("Client seed requires the isolated local profile");
}
const rooms = JSON.parse(process.env.SEED_CHANNELS_JSON || "{}") as Record<string, { members?: string[] }>;
// Only create the peer when the requested fixtures need her; an empty seed stays empty.
if (Object.values(rooms).some((room) => room.members?.includes("eve"))) {
  const { accountByNick, provisionAccount } = await import("../src/accounts.ts");
  const eve = accountByNick("eve") ?? await provisionAccount("eve", "eve@example.test");
  if (eve.nick !== "eve" || eve.email !== "eve@example.test") throw new Error("Client Eve identity conflicts with existing data");
}
await import("../src/seed.ts");

// The selected profile is already validated above; boot-seed keeps its own explicit
// two-factor guard and reuses only these disposable local fixture accounts.
if (Object.keys(rooms).length > 0) {
  process.env.SLIRC_BOOT_SEED = "true";
  await import("./boot-seed.ts");
}

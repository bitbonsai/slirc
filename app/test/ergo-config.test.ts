import { expect, test } from "bun:test";

// C1: with creation open, any IRC connection (6697 takes connections without SASL) could JOIN a
// predictable `#dm-` or `#t-` name first and hold op there. Only the app's oper may create channels;
// it needs `chanreg` for that and `sajoin` for the SAJOIN that creates them (grants.ts).
test("only operators can create channels, and the app's oper class can", async () => {
  const config = Bun.YAML.parse(await Bun.file(new URL("../../ergo/ergo.example.yaml", import.meta.url)).text()) as any;
  expect(config.channels["operator-only-creation"]).toBe(true);
  const oper = config.opers["slirc-org"];
  expect(config["oper-classes"][oper.class].capabilities).toEqual(expect.arrayContaining(["chanreg", "sajoin", "samode"]));
});

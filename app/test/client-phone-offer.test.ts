// Phone pairing by QR, client side: the desktop card, the scanned-link landing, and the scanner's
// acceptance rule. Fakes only; camera and real-device behaviour are checked on a phone.
import { describe, expect, test } from "bun:test";
import { createPhoneOffer, dismissPhoneShortcut, landOffer, offerToken, otherWorkspacePairLink, phoneShortcutDismissed, redeemOffer } from "../client/phone-offer.ts";
import { createQrScanner } from "../client/qr-scanner.ts";

const reactive = <T extends object>(value: T) => value;
const origin = "https://app.slirc.org";
const token = "t".repeat(43);
const link = `${origin}/pair#o=${token}`;
const json = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("offerToken", () => {
  test("accepts only this origin's pair link with a well-formed token", () => {
    expect(offerToken(link, origin)).toBe(token);
    expect(offerToken(`${origin}/pair?x=1#o=${token}`, origin)).toBe(token);
  });

  test("ignores everything else", () => {
    const rejected = [
      "", "hello", token, `#o=${token}`, `/pair#o=${token}`,
      `https://evil.example/pair#o=${token}`,
      `http://app.slirc.org/pair#o=${token}`,
      `https://app.slirc.org:8443/pair#o=${token}`,
      `https://app.slirc.org.evil.example/pair#o=${token}`,
      `https://app.slirc.org@evil.example/pair#o=${token}`,
      `https://user:pass@app.slirc.org/pair#o=${token}`,
      `https://evil.example\\@app.slirc.org/pair#o=${token}`,
      `${origin}/pair/#o=${token}`, `${origin}/pair/123456`, `${origin}/pairs#o=${token}`, `${origin}/#o=${token}`,
      `${origin}/pair?o=${token}`, `${origin}/pair`, `${origin}/pair#o=`, `${origin}/pair#o=short`,
      `${origin}/pair#o=${token}x`, `${origin}/pair#o=${"t".repeat(42)}!`, `${origin}/pair#token=${token}`,
      `javascript:alert(1)//${origin}/pair#o=${token}`, `${origin}/pair#o=${token}`.padEnd(600, "a"),
      null, undefined, 7, { href: link },
    ];
    for (const value of rejected) expect(offerToken(value, origin)).toBeNull();
  });
});

describe("landOffer", () => {
  test("removes the fragment before any request, then redeems", async () => {
    const order: string[] = [];
    const history = { replaceState: (_data: unknown, _unused: string, url: string) => { order.push(`replace:${url}`); } };
    const fetcher = async (input: string, init?: RequestInit) => {
      order.push(`fetch:${init?.method}:${input}`);
      expect(JSON.parse(String(init?.body))).toEqual({ token });
      expect((init?.headers as Record<string, string>)["X-Slirc-Pair"]).toBe("1");
      return json(200, { signedIn: true });
    };
    expect(await landOffer({ href: link, origin, pathname: "/pair" }, history, fetcher)).toBe("");
    expect(order).toEqual(["replace:/", "fetch:POST:/api/pair/offer/redeem"]);
  });

  test("does nothing on other routes, even with a token in the fragment", async () => {
    const calls: string[] = [];
    const history = { replaceState: () => { calls.push("replace"); } };
    const fetcher = async () => { calls.push("fetch"); return json(200); };
    expect(await landOffer({ href: `${origin}/#o=${token}`, origin, pathname: "/" }, history, fetcher)).toBeNull();
    expect(await landOffer({ href: `${origin}/pair/123456`, origin, pathname: "/pair/123456" }, history, fetcher)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a pair link without a usable token cleans the address and asks for a new code, with no request", async () => {
    const calls: string[] = [];
    const history = { replaceState: (_d: unknown, _u: string, url: string) => { calls.push(`replace:${url}`); } };
    const fetcher = async () => { calls.push("fetch"); return json(200); };
    expect(await landOffer({ href: `${origin}/pair#o=bad`, origin, pathname: "/pair" }, history, fetcher)).toContain("no longer valid");
    expect(calls).toEqual(["replace:/"]);
  });

  test("a refused or unreachable redeem returns a message", async () => {
    expect(await redeemOffer(token, async () => json(400, { error: "That code is no longer valid. Show a new one and scan again." }))).toContain("no longer valid");
    expect(await redeemOffer(token, async () => json(429, { error: "Too many attempts. Try again later." }))).toBe("Too many attempts. Try again later.");
    expect(await redeemOffer(token, async () => { throw new Error("offline"); })).toContain("Could not reach");
  });
});

function card(options: { hidden?: boolean; fail?: boolean } = {}) {
  const calls: string[] = [];
  const phones: number[] = [];
  let clock = 1_000;
  let minted = 0;
  const state = { hidden: !!options.hidden, fail: !!options.fail, signOutStatus: 204 };
  const offer = createPhoneOffer(reactive, {
    now: () => clock,
    onPhone: () => { phones.push(1); },
    visible: () => !state.hidden,
    fetcher: async (input, init) => {
      calls.push(`${init?.method} ${input}`);
      expect((init?.headers as Record<string, string>)["X-Slirc-Pair"]).toBe("1");
      if (init?.method === "POST") {
        if (state.fail) return json(429, { error: "Too many codes. Try again later." });
        minted += 1;
        return json(201, { id: `offer-${minted}`, url: `${origin}/pair#o=${String(minted).repeat(43)}`, expiresAt: clock + 60_000 });
      }
      return json(input.endsWith("/session") ? state.signOutStatus : 204);
    },
  });
  return { offer, calls, state, phones, advance: (ms: number) => { clock += ms; offer.tick(); } };
}

describe("desktop card", () => {
  test("opening mints an offer and counts down", async () => {
    const { offer, calls, advance } = card();
    await offer.show();
    expect(calls).toEqual(["POST /api/pair/offer"]);
    expect(offer).toMatchObject({ open: true, id: "offer-1", secondsLeft: 60, stale: false });
    expect(offer.url).toContain("/pair#o=");
    advance(15_500);
    expect(offer.secondsLeft).toBe(45);
    offer.close();
  });

  test("an expired code is replaced five times, then asks to be shown again", async () => {
    const { offer, calls, advance } = card();
    await offer.show();
    for (let refresh = 1; refresh <= 5; refresh++) {
      advance(60_000);
      await settle();
      expect(offer.id).toBe(`offer-${refresh + 1}`);
    }
    advance(60_000);
    await settle();
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(6);
    expect(offer).toMatchObject({ open: true, url: "", stale: true });
    await offer.again();
    expect(offer).toMatchObject({ id: "offer-7", stale: false });
    advance(60_000);
    await settle();
    expect(offer.id).toBe("offer-8");
    offer.close();
  });

  test("closing cancels the unused offer and clears the code", async () => {
    const { offer, calls } = card();
    await offer.show();
    offer.close();
    expect(calls).toEqual(["POST /api/pair/offer", "DELETE /api/pair/offer"]);
    expect(offer).toMatchObject({ open: false, url: "", id: "" });
    offer.close();
    expect(calls).toHaveLength(2);
  });

  test("a hidden page closes the card, cancels the offer and never mints", async () => {
    const { offer, calls, state, advance } = card();
    await offer.show();
    state.hidden = true;
    advance(1_000);
    expect(offer.open).toBe(false);
    expect(calls.at(-1)).toBe("DELETE /api/pair/offer");
    await offer.show();
    expect(offer.open).toBe(false);
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });

  test("a late mint answer after closing is dropped", async () => {
    const { offer } = card();
    const opening = offer.show();
    offer.close();
    await opening;
    expect(offer).toMatchObject({ open: false, url: "", id: "" });
  });

  test("a refused mint shows the reason and offers to try again", async () => {
    const { offer, state } = card({ fail: true });
    await offer.show();
    expect(offer).toMatchObject({ open: true, url: "", stale: true, error: "Too many codes. Try again later." });
    state.fail = false;
    await offer.again();
    expect(offer).toMatchObject({ error: "", stale: false, id: "offer-1" });
    offer.close();
  });

  test("only this card's offer id marks it redeemed, and the device text is bounded", async () => {
    const { offer, calls, advance } = card();
    await offer.show();
    offer.redeemed({ id: "someone-else", browser: "Safari", os: "iOS" });
    offer.redeemed(null);
    expect(offer.device).toBe("");
    offer.redeemed({ id: "offer-1", browser: "Safari", os: "x".repeat(200) });
    expect(offer.device).toBe(`Safari on ${"x".repeat(40)}`);
    expect(offer.url).toBe("");
    advance(120_000);
    await settle();
    expect(calls).toEqual(["POST /api/pair/offer"]);
    offer.close();
    // The offer was spent, so closing has nothing to cancel.
    expect(calls).toEqual(["POST /api/pair/offer"]);
  });

  test("sign it out revokes the session that offer started", async () => {
    const { offer, calls, state } = card();
    await offer.show();
    await offer.signOut();
    expect(calls).toHaveLength(1);
    offer.redeemed({ id: "offer-1", browser: "Safari", os: "iOS" });
    state.signOutStatus = 500;
    await offer.signOut();
    expect(offer).toMatchObject({ signedOut: false, signOutBusy: false });
    expect(offer.error).toContain("Could not sign it out");
    state.signOutStatus = 204;
    await offer.signOut();
    expect(calls.at(-1)).toBe("DELETE /api/pair/offer/offer-1/session");
    expect(offer).toMatchObject({ signedOut: true, error: "" });
    await offer.signOut();
    expect(calls.filter((call) => call.endsWith("/session"))).toHaveLength(2);
    offer.close();
  });
});

function scannerHarness(options: { camera?: "ok" | "denied"; redeem?: string } = {}) {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const redeemed: string[] = [];
  const navigated: string[] = [];
  let signedIn = 0;
  let queued: (() => void) | null = null;
  let next: string | null = null;
  const video = { srcObject: null as unknown, muted: false, setAttribute() {}, play: async () => {}, pause() {} } as unknown as HTMLVideoElement;
  const scanner = createQrScanner(reactive, {
    origin: () => origin,
    onSignedIn: () => { signedIn += 1; },
    redeem: async (value) => { redeemed.push(value); return options.redeem ?? ""; },
    navigate: (url) => { navigated.push(url); },
    camera: async () => { if (options.camera === "denied") throw new DOMException("denied", "NotAllowedError"); return stream; },
    decoder: async () => () => (next ? { data: next } : null),
    frame: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    schedule: (callback) => { queued = callback; return 1; },
    cancel: () => { queued = null; },
  });
  return { scanner, video, tracks, redeemed, navigated, signedIn: () => signedIn, show: (text: string | null) => { next = text; }, queued: () => queued };
}

describe("sidebar shortcut", () => {
  test("a redeem from a phone marks the account as having one; a laptop does not", async () => {
    for (const [os, expected] of [["iOS", 1], ["Android", 1], ["macOS", 0], ["Unknown OS", 0]] as const) {
      const { offer, phones } = card();
      await offer.show();
      offer.redeemed({ id: "offer-1", browser: "Safari", os });
      expect(phones).toHaveLength(expected);
      offer.close();
    }
  });

  test("dismissal is remembered per account", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    expect(phoneShortcutDismissed("acct-1", storage)).toBe(false);
    dismissPhoneShortcut("acct-1", storage);
    expect(phoneShortcutDismissed("acct-1", storage)).toBe(true);
    expect(phoneShortcutDismissed("acct-2", storage)).toBe(false);
    expect(phoneShortcutDismissed("", storage)).toBe(false);
    dismissPhoneShortcut("", storage);
    expect(store.size).toBe(1);
    // Storage that throws (private mode) never breaks the sidebar.
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(phoneShortcutDismissed("acct-1", broken)).toBe(false);
    expect(() => dismissPhoneShortcut("acct-1", broken)).not.toThrow();
  });
});

describe("phone scanner", () => {
  test("foreign and malformed codes are ignored and the camera keeps running", async () => {
    const { scanner, video, tracks, redeemed } = scannerHarness();
    await scanner.start(video);
    expect(scanner).toMatchObject({ open: true, scanning: true, error: "" });
    for (const value of ["WIFI:S:cafe;;", `${origin}/pair`, `${origin}/join/abc`, `${origin}/pair?o=${token}`]) {
      expect(await scanner.decoded(value)).toBe(false);
    }
    expect(redeemed).toEqual([]);
    expect(tracks[0]!.stopped).toBe(false);
    expect(scanner.scanning).toBe(true);
    scanner.close();
  });

  test("a valid code stops the camera at once, redeems, and signs in", async () => {
    const { scanner, video, tracks, redeemed, signedIn } = scannerHarness();
    await scanner.start(video);
    const accepted = scanner.decoded(link);
    expect(tracks[0]!.stopped).toBe(true);
    expect(video.srcObject).toBeNull();
    expect(await accepted).toBe(true);
    expect(redeemed).toEqual([token]);
    expect(signedIn()).toBe(1);
    expect(scanner.open).toBe(false);
  });

  test("the frame loop feeds decoded values through the same rule", async () => {
    const { scanner, video, redeemed, show } = scannerHarness();
    show(link);
    await scanner.start(video);
    await settle();
    expect(redeemed).toEqual([token]);
  });

  test("a dead code shows the reason and leaves the camera off", async () => {
    const { scanner, video, tracks, signedIn } = scannerHarness({ redeem: "That code is no longer valid. Show a new one and scan again." });
    await scanner.start(video);
    await scanner.decoded(link);
    expect(scanner).toMatchObject({ open: true, scanning: false, redeeming: false });
    expect(scanner.error).toContain("no longer valid");
    expect(tracks[0]!.stopped).toBe(true);
    expect(signedIn()).toBe(0);
  });

  test("camera denied says so in one line and points at the code flow", async () => {
    const { scanner, video, redeemed } = scannerHarness({ camera: "denied" });
    await scanner.start(video);
    expect(scanner).toMatchObject({ open: true, scanning: false, starting: false, error: "Camera unavailable. Link with a code instead." });
    expect(await scanner.decoded(link)).toBe(false);
    scanner.close();
    expect(redeemed).toEqual([]);
  });

  test("leaving the screen or hiding the page stops the camera", async () => {
    for (const leave of ["close", "hidden"] as const) {
      const { scanner, video, tracks, queued } = scannerHarness();
      await scanner.start(video);
      scanner[leave]();
      expect(tracks[0]!.stopped).toBe(true);
      expect(video.srcObject).toBeNull();
      expect(queued()).toBeNull();
      expect(scanner).toMatchObject({ open: false, scanning: false });
    }
  });
});

describe("shell wiring", () => {
  test("the card and scanner are in the assembled shell, the decoder is not", async () => {
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    expect(html).toContain("scanner.start($refs.scanVideo)");
    // The phone card sits on Devices, not on the profile screen.
    const devices = html.slice(html.indexOf('data-phone-screen="settings"'), html.indexOf('data-phone-screen="channels"'));
    expect(devices.indexOf('id="phone-offer-card"')).toBeGreaterThan(-1);
    expect(html.slice(html.indexOf('data-phone-screen="profile"'), html.indexOf('data-phone-screen="settings"'))).not.toContain("phoneOffer");
    expect(html).not.toContain("jsqr");
    // The card has no copy-link field and no warning text.
    const start = html.indexOf('id="phone-offer-card"');
    const cardHtml = html.slice(start, html.indexOf("</section>", start));
    expect(cardHtml).toContain("phoneOffer.url");
    expect(cardHtml).not.toMatch(/<input|<a |clipboard|copy link|warning/i);
    const sprite = await Bun.file(new URL("../public/icons/lucide/sprite.svg", import.meta.url)).text();
    expect(sprite).toContain('id="scan-line"');
  });

});

describe("another workspace's code", () => {
  const other = `https://ai-guild.slirc.app/pair#o=${token}`;

  test("otherWorkspacePairLink accepts only another https origin's pair link", () => {
    expect(otherWorkspacePairLink(other, origin)).toBe(other);
    for (const value of [link, `http://ai-guild.slirc.app/pair#o=${token}`, `https://ai-guild.slirc.app:8443/pair#o=${token}`, `https://me@ai-guild.slirc.app/pair#o=${token}`,
      "https://ai-guild.slirc.app/pair#o=short", `https://ai-guild.slirc.app/join/x#o=${token}`, "WIFI:S:cafe;;", null]) {
      expect(otherWorkspacePairLink(value, origin)).toBeNull();
    }
  });

  test("scanning it stops the camera, names the workspace, spends nothing, and opens it on request", async () => {
    const { scanner, video, tracks, redeemed, navigated, signedIn } = scannerHarness();
    await scanner.start(video);
    expect(await scanner.decoded(other)).toBe(true);
    expect(tracks[0]!.stopped).toBe(true);
    expect(redeemed).toEqual([]);
    expect(scanner).toMatchObject({ open: true, scanning: false, elsewhere: other });
    expect(scanner.error).toBe("This code is for ai-guild.slirc.app. Open that workspace to sign in there.");
    scanner.openElsewhere();
    expect(navigated).toEqual([other]);
    expect(scanner).toMatchObject({ open: false, error: "", elsewhere: "" });
    expect(signedIn()).toBe(0);
  });

  test("closing or scanning again forgets it", async () => {
    const { scanner, video, navigated } = scannerHarness();
    await scanner.start(video);
    await scanner.decoded(other);
    scanner.close();
    expect(scanner.elsewhere).toBe("");
    scanner.openElsewhere();
    expect(navigated).toEqual([]);
  });
});

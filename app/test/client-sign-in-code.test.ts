// Email code on the sign-in screen: the sixth digit submits, a wrong code shows the server's
// message and clears the field, and a good code navigates to the returned target. No browser.
import { expect, test } from "bun:test";
import { createSignIn } from "@client/sign-in.ts";

function setup(respond: (body: any) => Response) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const calls: { path: string; body: any }[] = [];
  const sent: Record<string, string>[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ path, body });
      sent.push((init?.headers as Record<string, string>) || {});
      return respond(body);
    },
  });
  const went: string[] = [];
  const core = { error: "" };
  const signIn = createSignIn((value) => value, core, (next) => { went.push(next); });
  signIn.email = " mara@example.test ";
  const restore = () => { if (saved) Object.defineProperty(globalThis, "fetch", saved); else Reflect.deleteProperty(globalThis, "fetch"); };
  return { signIn, calls, sent, went, restore };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the sixth digit submits the code and a good one navigates to the returned target", async () => {
  const { signIn, calls, went, restore } = setup(() => Response.json({ next: "/settings" }));
  try {
    signIn.code = "123 45";
    signIn.codeInput();
    expect(signIn.code).toBe("12345");
    expect(calls).toHaveLength(0);
    signIn.code = "123 456";
    signIn.codeInput();
    await settle();
    expect(calls).toEqual([{ path: "/auth/code", body: { email: "mara@example.test", code: "123456", next: "/" } }]);
    expect(went).toEqual(["/settings"]);
    // Stays busy until the page unloads, so a second submit cannot race the navigation.
    expect(signIn.codeBusy).toBe(true);
  } finally { restore(); }
});

test("a wrong code shows the server message, clears the field and allows a retry", async () => {
  const { signIn, calls, went, restore } = setup(() => Response.json({ error: "Wrong code. Try again." }, { status: 400 }));
  try {
    signIn.code = "000000";
    await signIn.submitCode();
    expect(signIn.codeError).toBe("Wrong code. Try again.");
    expect(signIn.code).toBe("");
    expect(signIn.codeBusy).toBe(false);
    expect(went).toEqual([]);
    signIn.code = "1";
    signIn.codeInput();
    expect(signIn.codeError).toBe("");
    await signIn.submitCode();
    expect(signIn.codeError).toBe("Enter the 6-digit code.");
    expect(calls).toHaveLength(1);
  } finally { restore(); }
});

test("an off-site return target falls back to the root", async () => {
  // The backslash form passes a naive leading-slash check, and browsers read it as "//".
  for (const next of ["//evil.example", "/\\evil.example", "https://evil.example", "/ok?x=1", 7]) {
    const { signIn, went, restore } = setup(() => Response.json({ next }));
    try {
      signIn.code = "123456";
      await signIn.submitCode();
      expect(went).toEqual(["/"]);
    } finally { restore(); }
  }
});

test("the code post carries the sign-in header, and a restored page frees the form", async () => {
  const { signIn, sent, restore } = setup(() => Response.json({ next: "/" }));
  try {
    signIn.code = "123456";
    await signIn.submitCode();
    expect(sent[0]!["X-Slirc-Sign-In"]).toBe("1");
    expect(signIn.codeBusy).toBe(true);
    // Back/forward cache restore: the page never unloaded, so the form must work again.
    signIn.restored();
    expect(signIn.codeBusy).toBe(false);
  } finally { restore(); }
});

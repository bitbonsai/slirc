import { expect, test } from "bun:test";
import { directInviteEmail, inviteEmail, magicLinkEmail } from "../src/email.ts";

// The pre-launch wording belongs to the public playground; the private case is checked below.
process.env.SLIRC_MODE = "public_playground";

test("magic link email carries the link, logo, and escapes untrusted text", () => {
  const url = "https://app.slirc.org/auth/verify?token=abc&next=%2F";
  const email = magicLinkEmail({ url, nick: "<script>x</script>", verified: false, origin: "https://app.slirc.org" });
  expect(email.subject).toBe("Verify your Slirc email for app.slirc.org");
  expect(email.html).toContain('href="https://app.slirc.org/auth/verify?token=abc&amp;next=%2F"');
  expect(email.html).not.toContain("<script>");
  expect(email.text).toContain(url);
  expect(magicLinkEmail({ url, nick: "bitbonsai", verified: true, origin: "https://app.slirc.org" }).subject).toBe("Your Slirc sign-in code for app.slirc.org");
  expect(email.html).not.toContain("Your code");
});

test("magic link email shows the sign-in code above the button when one was minted", () => {
  const url = "https://app.slirc.org/auth/verify?token=abc&next=%2F";
  const email = magicLinkEmail({ url, code: "042917", nick: "bitbonsai", verified: true, origin: "https://app.slirc.org" });
  expect(email.html).toContain(">042 917</p>");
  expect(email.html.indexOf("042 917")).toBeLessThan(email.html.indexOf('href="https://app.slirc.org/auth/verify'));
  expect(email.text).toContain("042 917");
  expect(email.text).toContain(url);
});

test("invite email names the room, the inviter, and escapes both", () => {
  const email = inviteEmail({ url: "https://app.slirc.org/join/abc", channel: "#garden", inviter: "<b>bitbonsai</b>", origin: "https://app.slirc.org" });
  expect(email.subject).toContain("invited you to #garden");
  expect(email.html).toContain('href="https://app.slirc.org/join/abc"');
  expect(email.html).toContain("&lt;b&gt;bitbonsai&lt;/b&gt;");
  expect(email.html).not.toContain("<b>");
  expect(email.text).toContain("https://app.slirc.org/join/abc");
});


test("invites name the inviter with their verified email and stay personal", () => {
  const channel = inviteEmail({ url: "https://app.slirc.org/join/abc", channel: "#garden", inviter: "Ada Lovelace", inviterEmail: "ada@example.com", origin: "https://app.slirc.org" });
  expect(channel.subject).toBe("Ada Lovelace invited you to #garden on app.slirc.org");
  expect(channel.text).toContain("Ada Lovelace (ada@example.com) invited you to #garden.");
  expect(channel.html).toContain("Ada Lovelace (ada@example.com) invited you to");
  expect(channel.text).toContain("Only this address can use it.");
  expect(channel.text).not.toContain("Anyone with this link");
  expect(channel.html).not.toContain("Anyone with this link");
  const direct = directInviteEmail({ url: "https://app.slirc.org/join/abc", inviter: "Ada Lovelace", inviterEmail: "ada@example.com", origin: "https://app.slirc.org" });
  expect(direct.subject).toBe("Ada Lovelace invited you to chat on app.slirc.org");
  expect(direct.text).toContain("Ada Lovelace (ada@example.com) invited you to a private conversation.");
  expect(direct.html).toContain("Ada Lovelace (ada@example.com) invited you to a private conversation.");
});

test("direct invite keeps the private-conversation framing, shares the layout, and escapes the inviter", () => {
  const email = directInviteEmail({ url: "https://app.slirc.org/join/abc", inviter: "<b>Ada</b>", origin: "https://app.slirc.org" });
  expect(email.subject).toBe("<b>Ada</b> invited you to chat on app.slirc.org");
  expect(email.html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
  expect(email.html).not.toContain("<b>");
  expect(email.text).toContain("Expires in seven days.");
  expect(email.text).not.toContain("#");
});

test("a private workspace invitation says Join and never mentions pre-launch", () => {
  process.env.SLIRC_MODE = "private_workspace";
  try {
    const room = inviteEmail({ url: "https://team.example/join/abc", channel: "#garden", inviter: "Ada", origin: "https://team.example" });
    const direct = directInviteEmail({ url: "https://team.example/join/abc", inviter: "Ada", origin: "https://team.example" });
    for (const email of [room, direct]) {
      expect(email.html).toContain(">Join</a>");
      expect(email.text).toContain("Join: https://team.example/join/abc");
      expect(email.html + email.text).not.toMatch(/pre-launch/i);
    }
    expect(room.text).toContain("Ada invited you to #garden.\n");
  } finally { process.env.SLIRC_MODE = "public_playground"; }
});

test("the footer drops the agents line on an instance with agents switched off", () => {
  const send = () => [
    inviteEmail({ url: "https://team.example/join/abc", channel: "#garden", inviter: "Ada", origin: "https://team.example" }).html,
    magicLinkEmail({ url: "https://team.example/auth/verify?token=abc", nick: "ada", verified: true, origin: "https://team.example" }).html,
  ];
  for (const html of send()) expect(html).toMatch(/agents/i);
  process.env.SLIRC_AGENTS_ENABLED = "false";
  try {
    for (const html of send()) {
      expect(html).not.toMatch(/agents/i);
    }
  } finally { delete process.env.SLIRC_AGENTS_ENABLED; }
});

test("emails carry the wordmark of their instance", () => {
  const args = { url: "https://example.com/x", nick: "ada", verified: true, origin: "https://example.com" };
  const previousBrand = process.env.SLIRC_BRAND;
  try {
    delete process.env.SLIRC_BRAND;
    process.env.SLIRC_MODE = "private_workspace";
    expect(magicLinkEmail(args).html).toContain("https://example.com/brand-org-dark@2x.png");
    process.env.SLIRC_BRAND = "slirc.app";
    expect(magicLinkEmail(args).html).toContain("https://example.com/brand-app-dark@2x.png");
  } finally {
    process.env.SLIRC_MODE = "public_playground";
    if (previousBrand === undefined) delete process.env.SLIRC_BRAND;
    else process.env.SLIRC_BRAND = previousBrand;
  }
});

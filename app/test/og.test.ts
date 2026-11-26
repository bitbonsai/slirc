import { describe, expect, test } from "bun:test";
import { decodeEntities, directImageEmbed, isPrivateIp, parseOg } from "../src/og.ts";

describe("parseOg", () => {
  test("extracts og tags, falling back to twitter and title", () => {
    const html = `<html><head>
      <meta property="og:title" content="The Post Title" />
      <meta name="twitter:description" content="A shorter blurb" />
      <meta property="og:image" content="https://example.com/pic.png" />
      <meta name="og:site_name" content="Example">
      <title>Ignored: og:title wins</title>
    </head></html>`;
    expect(parseOg(html)).toEqual({
      title: "The Post Title",
      description: "A shorter blurb",
      image: "https://example.com/pic.png",
      site: "Example",
    });
  });

  test("decodes entities in every value, so a signed image URL keeps its real query", () => {
    const html = `
      <meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Show&quot;">
      <meta property="og:description" content="caf&#233; &#x2014; &lt;b&gt; &apos;ok&apos;&nbsp;">
      <meta property="og:image" content="https://media.licdn.com/dms/image/x?e=2147483647&amp;v=beta&amp;t=abc">
      <meta property="og:site_name" content="A &AMP; B">`;
    expect(parseOg(html)).toEqual({
      title: `Tom & Jerry's "Show"`,
      description: "café — <b> 'ok'",
      image: "https://media.licdn.com/dms/image/x?e=2147483647&v=beta&t=abc",
      site: "A & B",
    });
  });
});

describe("decodeEntities", () => {
  test("decodes once, leaves unknown names alone and replaces invalid code points", () => {
    expect(decodeEntities("&amp;lt; &amp;amp;")).toBe("&lt; &amp;");
    expect(decodeEntities("&copy; &bogus; a&b")).toBe("&copy; &bogus; a&b");
    expect(decodeEntities("&#0;&#x110000;")).toBe("  ");
  });
});

describe("directImageEmbed", () => {
  test("accepts a content-type with parameters and either case", () => {
    expect(directImageEmbed("https://x.test/a.PNG", "Image/PNG; charset=binary")).not.toBeNull();
    expect(directImageEmbed("https://x.test/a.webp", "image/webp")).not.toBeNull();
  });

  test("ignores pages, missing or non-image types, and animated gifs", () => {
    expect(directImageEmbed("https://x.test/page", "text/html; charset=utf-8")).toBeNull();
    expect(directImageEmbed("https://x.test/page", null)).toBeNull();
    expect(directImageEmbed("https://x.test/pic.jpg", "image/gif")).toBeNull();
  });
});

describe("isPrivateIp", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.0.0.5", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["169.254.10.10", true],
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["224.0.0.1", true],
    ["::1", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["::ffff:10.0.0.1", true],
  ])("blocks %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  test.each([
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
    ["2606:2800:220:1:248:1893:25c8:1946", false],
    ["not-an-ip", false],
    ["", false],
  ])("allows %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe("isPrivateIp ipv4 ranges", () => {
  test.each([
    ["0.255.255.255", true],
    ["10.255.255.255", true],
    ["100.127.255.255", true],
    ["127.0.0.0", true],
    ["127.255.255.255", true],
    ["169.254.0.0", true],
    ["172.32.0.0", false],
    ["172.15.255.255", false],
    ["192.0.0.1", true],
    ["192.0.2.1", true],
    ["192.88.99.1", true],
    ["198.18.0.1", true],
    ["198.19.255.255", true],
    ["198.51.100.1", true],
    ["203.0.113.1", true],
    ["239.255.255.255", true],
    ["240.0.0.1", true],
    ["255.255.255.255", true],
    ["11.0.0.1", false],
    ["100.128.0.1", false],
    ["172.16.0.0", true],
    ["172.31.255.255", true],
    ["203.0.114.1", false],
    ["999.1.1.1", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe("isPrivateIp ipv6 forms", () => {
  test.each([
    ["::", true],
    ["::1", true],
    ["0:0:0:0:0:0:0:0", true],
    ["0:0:0:0:0:0:0:1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:7f00:0001", true],
    ["0:0:0:0:0:ffff:7f00:1", true],
    ["::ffff:a00:1", true],
    ["::ffff:c0a8:101", true],
    ["::ffff:169.254.1.1", true],
    ["::ffff:5db8:d822", false],
    ["::ffff:93.184.216.34", false],
    ["::ffff:8.8.8.8", false],
    ["::127.0.0.1", true],
    ["::93.184.216.34", false],
    ["::ffff:0:7f00:1", true],
    ["fe80::1", true],
    ["fe80::abcd:1", true],
    ["febf::1", true],
    ["fec0::1", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["ff02::1", true],
    ["2001:db8::1", true],
    ["2001:0000::1", true],
    ["2002:7f00:1::1", true],
    ["2002:5db8:d822::1", false],
    ["64:ff9b::7f00:1", true],
    ["64:ff9b::5db8:d822", false],
    ["100::1", true],
    ["[::1]", true],
    ["[2606:4700::6810:84e5]", false],
    ["fe80::1%eth0", true],
    ["2606:4700::6810:84e5", false],
    ["2606:2800:220:1:248:1893:25c8:1946", false],
    ["2001:4860:4860::8888", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

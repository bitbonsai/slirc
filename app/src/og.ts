import { isIP } from "node:net";
// OpenGraph / twitter-card extraction from raw HTML, plus the SSRF guard
// used by the embed proxy. Pure functions, unit-tested.

export interface EmbedMeta {
  title?: string;
  description?: string;
  image?: string;
  site?: string;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// Meta content is HTML attribute text: `&amp;` in a signed image URL must reach the fetch as `&`.
// One pass, so `&amp;lt;` becomes the literal `&lt;` and is never decoded twice.
export const decodeEntities = (text: string) => text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (_, dec: string, hex: string, name: string) => {
  if (name) return NAMED[name.toLowerCase()];
  const code = dec ? Number(dec) : parseInt(hex, 16);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
});

export function parseOg(html: string): EmbedMeta {
  const meta: Record<string, string> = {};
  // `<` is excluded so a page of unclosed `<meta ` cannot make each start scan to the end.
  const tagRe = /<meta\b[^<>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html))) {
    const attr = (name: string) => {
      const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
      const m = tag[0].match(re);
      return m ? m[1].trim() : "";
    };
    const key = (attr("property") || attr("name") || "").toLowerCase();
    const value = decodeEntities(attr("content") || "").trim();
    if (key && value && !(key in meta)) meta[key] = value;
  }
  const title = meta["og:title"] || meta["twitter:title"] || "";
  const description = meta["og:description"] || meta["twitter:description"] || "";
  const image = meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"] || "";
  const site = meta["og:site_name"] || "";
  const result: EmbedMeta = {};
  if (title) result.title = title.slice(0, 300);
  if (description) result.description = description.slice(0, 500);
  if (image) result.image = image;
  if (site) result.site = site.slice(0, 120);
  return result;
}

// A direct image URL: the fetched resource is the picture, not a page describing one.
// The `kind` marker is the validated discriminator the client uses to render an ordinary
// inline photo instead of a link card; bytes still load through the same-origin proxy, so
// the provider is never contacted by the browser and the SSRF/redirect guard applies.
// A query string (Pexels' `?auto=compress&w=1200`) is part of the URL and never a
// reason to skip recognition.
export function directImageEmbed(url: string, contentType: string | null): Record<string, string> | null {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  if (type !== "image/jpeg" && type !== "image/png" && type !== "image/webp") return null;
  return { kind: "image", image: url };
}

// Blocks requests into non-public networks (SSRF). Accepts IPv4 in any dotted form a
// resolver or URL parser may produce, and IPv6 compressed, expanded, bracketed,
// zone-qualified, or carrying an embedded IPv4 (mapped, translated, compatible,
// 6to4, NAT64). Anything that is not an IP literal is not treated as private; callers
// only pass literals or resolver answers.
export function isPrivateIp(input: string): boolean {
  let ip = input.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  // A hostname is not an address; the network layer will resolve it and the guard
  // runs again on the answer, so this is not a bypass.
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this-network/unspecified, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const words = expandIpv6(ip);
  if (!words) return true; // isIP accepted it, so a parse failure is not a safe address
  const [w0, w1] = words;
  if (words.every((word) => word === 0)) return true; // ::
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return isPrivateIpv4(wordsToIpv4(words[6], words[7]));
  if (words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff && words[5] === 0)
    return isPrivateIpv4(wordsToIpv4(words[6], words[7]));
  // Deprecated IPv4-compatible ::a.b.c.d (:: and ::1 are handled above).
  if (words.slice(0, 6).every((word) => word === 0)) return isPrivateIpv4(wordsToIpv4(words[6], words[7]));
  if ((w0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((w0 & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((w0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((w0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (w0 === 0x2001 && (w1 === 2 || (w1 & 0xfff0) === 0x10 || (w1 & 0xfff0) === 0x20)) return true; // benchmarking and ORCHID
  if (w0 === 0x3fff && (w1 & 0xf000) === 0) return true; // documentation 3fff::/20
  if (w0 === 0x2001 && w1 === 0x0db8) return true; // documentation 2001:db8::/32
  if (w0 === 0x2001 && w1 === 0x0000) return true; // Teredo 2001::/32 (embeds an address)
  if (w0 === 0x2002) return isPrivateIpv4(wordsToIpv4(words[1], words[2])); // 6to4 embeds IPv4
  if (w0 === 0x0064 && w1 === 0xff9b) {
    // Only the well-known /96 embeds IPv4 in the final 32 bits. Local-use /48 and
    // other translation prefixes may embed it elsewhere; never infer their destination.
    if (words.slice(2, 6).some((word) => word !== 0)) return true;
    return isPrivateIpv4(wordsToIpv4(words[6], words[7]));
  }
  return (w0 & 0xe000) !== 0x2000; // remaining addresses must be global unicast 2000::/3
}

function wordsToIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

// Eight 16-bit words, with "::" expanded and a trailing dotted quad folded in; null when malformed.
function expandIpv6(ip: string): number[] | null {
  let text = ip;
  const dotted = text.match(/(^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) {
    const quad = dotted[2].split(".").map(Number);
    if (quad.length !== 4 || quad.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    text = `${text.slice(0, dotted.index! + dotted[1].length)}${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((word) => (/^[0-9a-f]{1,4}$/.test(word) ? parseInt(word, 16) : NaN));
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

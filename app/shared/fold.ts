// The two foldings the app uses, in one place. foldIdentifier compares IRC names the way the server
// does (ASCII letters only, plus the bracket pairs for the older case mappings). foldText is for
// text a person types and reads: nicks, display names, channel names, hosts.

export type CaseMapping = "ascii" | "rfc1459" | "strict-rfc1459";

export function foldIdentifier(value: string, mapping: CaseMapping = "ascii"): string {
  const lower = value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  if (mapping === "ascii") return lower;
  return lower.replace(/[\[\]\\^]/g, (ch) =>
    ({ "[": "{", "]": "}", "\\": "|", "^": mapping === "rfc1459" ? "~" : "^" })[ch]!);
}

export function foldText(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

// Spans for "in 20m" reminders and "for 1h" polls. Pure, so the browser can read them the same way.
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const YEAR = 365 * DAY;

// s/sec, m/min, h/hour, d/day, y/year. First letter picks length; word boundary rejects prefixes such as months.
export const UNIT = "s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|y|yr|yrs|year|years";
const SPANS: Record<string, number> = { s: SECOND, m: MINUTE, h: HOUR, d: DAY, y: YEAR };
export const spanMs = (unit: string) => SPANS[unit[0]!.toLowerCase()] ?? MINUTE;

// "1h", "20 min", "2 days": one span, no text around it.
export function parseDuration(input: string): number | null {
  const match = input.trim().match(new RegExp(`^(\\d{1,4})\\s*(${UNIT})$`, "i"));
  return match ? Number(match[1]) * spanMs(match[2]!) : null;
}

export const profileBadgeOptions = [
  { value: "available", label: "Online", emoji: "" },
  { value: "away", label: "Away", emoji: "" },
  { value: "busy", label: "Busy", emoji: "" },
  { value: "focus", label: "Focus", emoji: "🎯" },
  { value: "break", label: "Break", emoji: "☕" },
  { value: "resting", label: "Resting", emoji: "💤" },
  { value: "vacation", label: "Vacation", emoji: "🌴" },
] as const;

export type ProfileBadge = "" | typeof profileBadgeOptions[number]["value"];

export function normalizeProfileBadge(value: unknown): ProfileBadge {
  return profileBadgeOptions.find((option) => option.value === value)?.value ?? "";
}

import { normalizeProfileBadge, type ProfileBadge } from "../shared/profile-badges.ts";

export async function prepareProfilePhoto(file: File): Promise<{ mime: string; data: string }> {
  if (!file.type.startsWith("image/") || !file.size) throw new Error("Choose a photo.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { throw new Error("Could not read this photo. Try a JPEG, PNG or WebP image."); }
    const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare this photo.");
    // ponytail: resized stills, no crop editor. Canvas also strips the photo's original metadata.
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const encoded = canvas.toDataURL("image/webp", 0.85);
    const match = /^data:(image\/(?:webp|png));base64,(.+)$/.exec(encoded);
    if (!match || atob(match[2]!).length > 4 * 1024 * 1024) throw new Error("Could not prepare this photo. Try a smaller image.");
    return { mime: match[1]!, data: match[2]! };
  } finally { URL.revokeObjectURL(url); }
}

export interface ProfileFields {
  fullName: string;
  about: string;
  availability: string;
  badge: ProfileBadge;
}

export function profileFields(source: unknown): ProfileFields {
  const body = (source ?? {}) as { fullName?: unknown; about?: unknown; availability?: unknown; badge?: unknown };
  const availability = typeof body.availability === "string" ? body.availability : "";
  return {
    fullName: typeof body.fullName === "string" ? body.fullName : "",
    about: typeof body.about === "string" ? body.about : "",
    availability,
    badge: normalizeProfileBadge(body.badge) || (availability.trim().toLowerCase() === "busy" ? "busy" : "available"),
  };
}

export function sameProfileFields(a: ProfileFields, b: ProfileFields): boolean {
  return a.fullName === b.fullName && a.about === b.about && a.availability === b.availability && a.badge === b.badge;
}

export function reconcileProfileFields(current: ProfileFields, baseline: ProfileFields, server: ProfileFields): { form: ProfileFields; saved: ProfileFields } {
  return {
    form: sameProfileFields(current, baseline) ? { ...server } : { ...current },
    saved: { ...server },
  };
}

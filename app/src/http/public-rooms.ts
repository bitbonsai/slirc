import { openChannels } from "../rooms.ts";
import { openRoom } from "../welcome.ts";

// Public rooms route the app on their own paths; the HTML does not wait on IRC 001.
const PUBLIC_ROOM_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const publicRoomPaths = () => new Set(
  ["open-chat", "help", ...openChannels.map((channel) => channel.replace(/^#/, "")), openRoom().replace(/^#/, "")]
    .map((slug) => slug.toLowerCase())
    .filter((slug) => PUBLIC_ROOM_SLUG.test(slug)),
);

export const isPublicRoomNext = (next: string) =>
  next.startsWith("/") && !next.slice(1).includes("/") && publicRoomPaths().has(next.slice(1).toLowerCase());

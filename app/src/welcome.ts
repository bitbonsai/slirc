import { db } from "./db.ts";

// The welcome helper lives in the public room and posts the daily G'day gif (helper-bot.ts). It
// used to greet unverified newcomers, but every sign-in now verifies the email before a session
// starts, so nobody unverified can reach the room. The welcomes table is unused; it stays so
// existing rows are not dropped.
db.exec(`CREATE TABLE IF NOT EXISTS welcomes (
  nick TEXT PRIMARY KEY COLLATE NOCASE,
  started_at INTEGER NOT NULL,
  greeted_at INTEGER,
  last_line_at INTEGER NOT NULL,
  replies INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0
)`);

export const openRoom = () => (process.env.OPEN_CHAT_ROOM || "#open-chat").toLowerCase();

import { currentUser, sameOriginJson } from "../http/session.ts";
import { accountByNick } from "../accounts.ts";
import { bodyLimit } from "hono/body-limit";
import { listNotes, noteBody, addNote, editNote, deleteNote } from "../notes.ts";
import { publish } from "../live.ts";
import { Hono } from "hono";

export const notes = new Hono();

// Notes: the signed-in person's private scratchpad. App-only, never IRC. Every read and write is
// keyed by the session's own account id; another account's note id answers 404 like a missing one.
// Writes tell the owner's other tabs and devices over /api/events so they reload the list.
function notesOwner(c: any) {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  return account?.kind === "human" ? account : null;
}

const notesCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Notes");

notes.use("/api/notes*", bodyLimit({ maxSize: 16_384 }));

notes.use("/api/notes*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

notes.get("/api/notes", (c) => {
  const account = notesOwner(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  return c.json({ notes: listNotes(account.id) });
});

notes.post("/api/notes", async (c) => {
  const account = notesOwner(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (!notesCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = noteBody((await c.req.json().catch(() => ({})))?.body);
  if (!body) return c.json({ error: "Write something first, up to 4000 characters." }, 400);
  const note = addNote(account.id, body);
  publish(account.nick, "notes", {});
  return c.json({ note });
});

notes.patch("/api/notes/:id", async (c) => {
  const account = notesOwner(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (!notesCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = noteBody((await c.req.json().catch(() => ({})))?.body);
  if (!body) return c.json({ error: "Write something first, up to 4000 characters." }, 400);
  const note = editNote(account.id, c.req.param("id"), body);
  if (!note) return c.json({ error: "note not found" }, 404);
  publish(account.nick, "notes", {});
  return c.json({ note });
});

notes.delete("/api/notes/:id", (c) => {
  const account = notesOwner(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (!notesCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  if (!deleteNote(account.id, c.req.param("id"))) return c.json({ error: "note not found" }, 404);
  publish(account.nick, "notes", {});
  return c.body(null, 204);
});

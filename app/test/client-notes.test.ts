// Notes client: /notes is its own screen, notes render as confirmed rows by their owner, and the
// list follows the server through add, edit, delete and a reload. No IRC anywhere.
import { expect, test } from "bun:test";
import { createNotes, noteMessage, type Note } from "../client/notes.ts";
import { NOTES_CONVERSATION_ID, parseRoute, resolveConversationId, routeUrl } from "../client/navigation.ts";
import { canDeleteMessage, canEditMessage } from "../client/presentation.ts";

const ORIGIN = "https://app.slirc.org";
const reactive = <T extends object>(value: T) => value;

test("/notes parses to the Notes screen and back, with its own conversation id", () => {
  expect(parseRoute("/notes", ORIGIN)).toEqual({ kind: "notes" });
  expect(parseRoute("/notes?msg=x", ORIGIN)).toBeNull();
  expect(routeUrl({ kind: "notes" })).toBe("/notes");
  expect(resolveConversationId({ kind: "notes" })).toBe(NOTES_CONVERSATION_ID);
});

test("a note is a confirmed row its owner can edit and delete", () => {
  const message = noteMessage({ id: "n1", body: "hi", createdAt: 0, updatedAt: 0 }, "nora", "Nora");
  expect(message).toMatchObject({ conversationId: NOTES_CONVERSATION_ID, serverId: "n1", text: "hi", state: "confirmed" });
  expect(canEditMessage(message, "nora")).toBe(true);
  expect(canDeleteMessage(message, "nora", false)).toBe(true);
});

test("the list follows add, edit, delete and reload, and sends the same-origin header", async () => {
  let server: Note[] = [];
  const calls: { method: string; url: string; header: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, header: new Headers(init.headers).get("X-Slirc-Notes") });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (method === "GET") return Response.json({ notes: server });
    if (method === "POST") { const note = { id: `n${server.length + 1}`, body: body.body, createdAt: 1, updatedAt: 1 }; server.push(note); return Response.json({ note }); }
    const id = url.split("/").pop();
    if (method === "PATCH") { server = server.map((note) => note.id === id ? { ...note, body: body.body } : note); return Response.json({ note: server.find((note) => note.id === id) }); }
    if (method === "DELETE") { server = server.filter((note) => note.id !== id); return new Response(null, { status: 204 }); }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const notes = createNotes(reactive, { fetcher });

  await notes.add("one");
  await notes.add("two");
  await notes.save("n1", "one, edited");
  await notes.remove("n2");
  expect(notes.list.map((note) => note.body)).toEqual(["one, edited"]);

  server.push({ id: "n9", body: "from the phone", createdAt: 2, updatedAt: 2 });
  await notes.load();
  expect(notes.list.map((note) => note.body)).toEqual(["one, edited", "from the phone"]);
  expect(calls.filter((call) => call.method !== "GET").every((call) => call.header === "1")).toBe(true);

  notes.reset();
  expect(notes.list).toEqual([]);
});

test("a refused write throws the server's reason and leaves the list alone", async () => {
  const fetcher = (async () => Response.json({ error: "note not found" }, { status: 404 })) as unknown as typeof fetch;
  const notes = createNotes(reactive, { fetcher });
  notes.list = [{ id: "a", body: "keep", createdAt: 1, updatedAt: 1 }];
  await expect(notes.save("a", "x")).rejects.toThrow("note not found");
  await expect(notes.remove("a")).rejects.toThrow("note not found");
  expect(notes.list.map((note) => note.body)).toEqual(["keep"]);
});

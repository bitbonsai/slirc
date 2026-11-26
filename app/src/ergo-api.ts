import { readFileSync } from "node:fs";

// Ergo's HTTP API. Its own module so irc-migration.ts can call it without loading accounts.ts,
// which writes the owner row on import and fails while the stored-password column is still there.
export type ErgoResponse = { success: boolean; errorCode?: string; error?: string; channels?: ({ name: string } | string)[]; lastSeen?: string | number | null };

export async function ergo(path: string, body: Record<string, unknown>): Promise<ErgoResponse> {
  if (process.env.ERGO_API_MOCK === "true") return { success: true };
  const url = process.env.ERGO_API_URL || "http://10.89.0.2:8089";
  let token = "";
  try { token = readFileSync(process.env.ERGO_API_TOKEN_FILE || "/run/secrets/ergo-api-token", "utf8").trim(); } catch {}
  token ||= process.env.ERGO_API_TOKEN || "";
  if (!token) throw new Error("ERGO_API_TOKEN required");
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Ergo API returned ${response.status}`);
  return response.json() as Promise<ErgoResponse>;
}

/** Pairing a machine through the real device-code flow (TUN-*). */
import type { Client } from "../core/client";

/**
 * `POST /v1/tunnel/device-auth` (public, 5 per minute per client address).
 * Locally the single `x-forwarded-for` entry is the client, so each call gets
 * its own bucket; behind real proxies the header is ignored and a 429 waits
 * out the window.
 */
export async function startPairing(anon: Client, body: Record<string, unknown>) {
  const deadline = Date.now() + 75_000;
  for (;;) {
    const r = await anon.post("/v1/tunnel/device-auth", body, {
      headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
    });
    if (r.statusCode !== 429 || Date.now() > deadline) return r;
    await Bun.sleep(Math.min(Number(r.json<any>()?.retryAfterMs) || 5_000, 20_000));
  }
}

/** Pair a machine into `projectId` through the real device flow. */
export async function pair(
  anon: Client,
  approver: Client,
  input: { name: string; projectId: string; capabilities: string[]; share?: "me" | "project" },
): Promise<{ tunnelId: string; connectionId: string; token: string }> {
  const created = await startPairing(anon, {
    machineHostname: `${input.name}.local`,
    project_id: input.projectId,
  });
  created.status(201);
  const { deviceCode, deviceSecret } = created.json<any>();
  const approved = await approver.post(
    "/v1/tunnel/device-auth/:code/approve",
    { name: input.name, capabilities: input.capabilities, ...(input.share ? { share: input.share } : {}) },
    { params: { code: deviceCode } },
  );
  approved.status(200).body().exists("$.tunnelId").exists("$.connectionId");
  const poll = await anon
    .withBearer(deviceSecret)
    .get("/v1/tunnel/device-auth/:code/status", { params: { code: deviceCode } });
  poll.status(200).body().has("$.status", "approved");
  return {
    tunnelId: approved.json<any>().tunnelId,
    connectionId: approved.json<any>().connectionId,
    token: poll.json<any>().token,
  };
}

/** Pairing a machine through the real device-code flow (TUN-*). */
import { strict as assert } from "node:assert";
import type { Client } from "../core/client";
import { waitFor } from "../core/poll";

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

/**
 * A member's machines in both placements (KRTX-1722): one paired privately,
 * which lives in their personal account and reaches the project through their
 * private computer account, and one shared with the project, which joins the
 * team account. Sharing needs the project's manager role.
 */
export async function pairBothPlacements(
  anon: Client,
  member: Client,
  input: { projectId: string; name: (slug: string) => string },
) {
  const capabilities = ["filesystem"];
  return {
    personal: await pair(anon, member, { name: input.name("leaver-laptop"), projectId: input.projectId, capabilities }),
    shared: await pair(anon, member, {
      name: input.name("leaver-studio"),
      projectId: input.projectId,
      capabilities,
      share: "project",
    }),
  };
}

/** One computer account of the project, as `client` lists it. */
export async function projectComputerAccount(client: Client, projectId: string, connectionId: string) {
  const r = await client.get("/v1/projects/:projectId/connections", { params: { projectId } });
  r.status(200);
  return r.json<any>().connections.find((c: any) => c.connection_id === connectionId);
}

/**
 * The `member.offboarded` audit event of `userId` in the account: exactly one
 * per offboarding (KRTX-1722). Audit writes are queued, so poll for it.
 */
export async function offboardingEvent(owner: Client, accountId: string, userId: string) {
  const events = await waitFor(
    async () => {
      const r = await owner.get("/v1/accounts/:accountId/audit", {
        params: { accountId },
        query: { action: "member.offboarded" },
      });
      r.status(200);
      return r.json<{ events: any[] }>().events.filter((e) => e.resource_id === userId);
    },
    { until: (rows) => rows.length > 0, timeoutMs: 30_000, intervalMs: 1_000, description: "the member.offboarded audit event" },
  );
  assert.equal(events.length, 1, `one member.offboarded event per offboarding: ${JSON.stringify(events)}`);
  return events[0];
}

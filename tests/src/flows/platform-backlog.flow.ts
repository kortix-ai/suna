/**
 * Platform backlog — three spec IDs whose handlers don't match their stale spec
 * text. Each maps 1:1 to a spec ID; behavior is derived from the real handlers
 * in apps/api/src, not the spec prose.
 *
 *  - PLT-2: platform API keys. NOTE the drift: the spec frames these as plain
 *    account-level keys, but the handler (apps/api/src/platform/routes/api-keys.ts)
 *    is SANDBOX-SCOPED — every route hinges on a `sandbox_id` (query/body) and
 *    `requireSandboxAccess` (sandbox must exist + caller must be owner/admin of
 *    the sandbox's account). A full create→use→mutate→delete chain needs a real
 *    booted sandbox (Daytona), which the boundary surface below does not require.
 *    We cover the auth gate (supabaseAuth → 401), the sandbox_id validation
 *    (missing → 400, non-UUID → 400, unknown UUID → 404), and the key-id
 *    boundaries (unknown keyId → 404 on revoke/delete/regenerate). These all run
 *    locally without provisioning a sandbox or minting a usable secret.
 *
 *  - RTR-4: billed router passthrough. DRIFT: the per-service proxy routes are
 *    registered via `proxy.all(...)` (method ALL), which the route dumper skips,
 *    so neither `ALL /v1/router/:service` nor the concrete `/tavily/*` mounts
 *    appear in the manifest. We exercise the router's auth/disallowed boundary
 *    via the manifest-present `POST /v1/router/web-search` (apiKeyAuth: no/garbage
 *    token → 401) and prove the router is mounted via the public
 *    `GET /v1/router/health`. We deliberately never send a valid Kortix token to
 *    a billed endpoint (that would make a real upstream call).
 */
import { flow } from "../core/flow";

const ZERO_UUID = "00000000-0000-4000-a000-000000000000";

// ─── PLT-2 — platform (sandbox-scoped) API keys ──────────────────────────
flow(
  "PLT-2",
  {
    domain: "accounts",
    serial: true,
    routes: [
      "GET /v1/platform/api-keys",
      "POST /v1/platform/api-keys",
      "PATCH /v1/platform/api-keys/:keyId/revoke",
      "DELETE /v1/platform/api-keys/:keyId",
      "POST /v1/platform/api-keys/:keyId/regenerate",
    ],
  },
  async (ctx) => {
    // ── auth gate (supabaseAuth) ──
    await ctx.step("ANON cannot list → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/platform/api-keys");
      r.status(401);
    });
    await ctx.step("ANON cannot create → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/platform/api-keys", { sandbox_id: ZERO_UUID, title: "x" });
      r.status(401);
    });

    // ── list: sandbox_id is required + validated ──
    await ctx.step("OWNER list without sandbox_id → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/platform/api-keys");
      r.status(400);
    });
    await ctx.step("OWNER list with a non-UUID sandbox_id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/platform/api-keys", { query: { sandbox_id: "not-a-uuid" } });
      r.status(400);
    });
    await ctx.step("OWNER list with an unknown sandbox UUID → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/platform/api-keys", { query: { sandbox_id: ZERO_UUID } });
      r.status(404);
    });

    // ── create: sandbox_id (body) is required + validated ──
    await ctx.step("OWNER create without sandbox_id → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/platform/api-keys", { title: "x" });
      r.status(400);
    });
    await ctx.step("OWNER create with an unknown sandbox UUID → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/platform/api-keys", { sandbox_id: ZERO_UUID, title: "x" });
      r.status(404);
    });

    // ── key-id boundaries (requireKeyAccess → unknown key → 404) ──
    await ctx.step("OWNER revoke an unknown keyId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/platform/api-keys/:keyId/revoke", {}, { params: { keyId: ZERO_UUID } });
      r.status(404);
    });
    await ctx.step("OWNER regenerate an unknown keyId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/platform/api-keys/:keyId/regenerate", {}, { params: { keyId: ZERO_UUID } });
      r.status(404);
    });
    await ctx.step("OWNER delete an unknown keyId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/platform/api-keys/:keyId", { params: { keyId: ZERO_UUID } });
      r.status(404);
    });
    await ctx.step("ANON cannot revoke → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch("/v1/platform/api-keys/:keyId/revoke", {}, { params: { keyId: ZERO_UUID } });
      r.status(401);
    });
  },
);

// ─── RTR-4 — billed router passthrough (auth / disallowed boundary) ───────
flow(
  "RTR-4",
  {
    domain: "accounts",
    routes: ["GET /v1/router/health", "POST /v1/router/web-search"],
  },
  async (ctx) => {
    await ctx.step("router is mounted: GET /router/health is public → 200", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/router/health");
      r.status(200).body().has("$.status", "ok").has("$.service", "kortix-router");
    });
    await ctx.step("billed endpoint without any token → 401 (apiKeyAuth)", async () => {
      // No Authorization header at all — apiKeyAuth rejects before any upstream call.
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/router/web-search", { query: "noop" });
      r.status(401);
    });
    await ctx.step("billed endpoint with a non-kortix bearer → 401 (bad token format)", async () => {
      // A garbage bearer that isn't a kortix_ token — rejected on format, never billed.
      const r = await ctx.client
        .withBearer("definitely-not-a-kortix-token", "BOGUS")
        .post("/v1/router/web-search", { query: "noop" });
      r.status([401, 403]);
    });
  },
);

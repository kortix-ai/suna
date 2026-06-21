/**
 * Platform — sandbox-scoped api-keys CRUD. Maps to spec §… (PLT-*).
 *
 * Contract notes (verified against apps/api/src/platform):
 * - /v1/platform/api-keys/* is guarded by `supabaseAuth` → ANON → 401.
 *   The router is SANDBOX-scoped: GET needs a `sandbox_id` query param,
 *   POST needs `sandbox_id` in the body. Missing/non-UUID sandbox_id → 400.
 *   The :keyId mutation routes look the key up first → unknown keyId → 404.
 */
import { flow } from "../core/flow";

const UNKNOWN_KEY_ID = "00000000-0000-4000-a000-000000000000";

flow("PLT-4", { domain: "platform", routes: ["GET /v1/platform/api-keys"] }, async (ctx) => {
  await ctx.step("ANON → 401 (auth required)", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/platform/api-keys");
    r.status(401);
  });
  await ctx.step("missing sandbox_id → 400", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/platform/api-keys");
    r.status(400);
  });
  await ctx.step("non-UUID sandbox_id → 400", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/platform/api-keys", { query: { sandbox_id: "not-a-uuid" } });
    r.status(400);
  });
  await ctx.step("unknown (well-formed) sandbox_id → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/platform/api-keys", { query: { sandbox_id: UNKNOWN_KEY_ID } });
    r.status(404);
  });
});

flow("PLT-5", { domain: "platform", routes: ["POST /v1/platform/api-keys"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/platform/api-keys", { title: "nope" });
    r.status(401);
  });
  await ctx.step("missing sandbox_id → 400", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/platform/api-keys", { title: "x" });
    r.status(400);
  });
  await ctx.step("non-UUID sandbox_id → 400", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/platform/api-keys", { sandbox_id: "not-a-uuid", title: "x" });
    r.status(400);
  });
  await ctx.step("unknown (well-formed) sandbox_id → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post("/v1/platform/api-keys", { sandbox_id: UNKNOWN_KEY_ID, title: "x" });
    r.status(404);
  });
});

flow("PLT-6", { domain: "platform", routes: ["DELETE /v1/platform/api-keys/:keyId"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).del("/v1/platform/api-keys/:keyId", { params: { keyId: UNKNOWN_KEY_ID } });
    r.status(401);
  });
  await ctx.step("unknown keyId → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .del("/v1/platform/api-keys/:keyId", { params: { keyId: UNKNOWN_KEY_ID } });
    r.status(404);
  });
});

flow("PLT-7", { domain: "platform", routes: ["POST /v1/platform/api-keys/:keyId/regenerate"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .post("/v1/platform/api-keys/:keyId/regenerate", {}, { params: { keyId: UNKNOWN_KEY_ID } });
    r.status(401);
  });
  await ctx.step("unknown keyId → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .post("/v1/platform/api-keys/:keyId/regenerate", {}, { params: { keyId: UNKNOWN_KEY_ID } });
    r.status(404);
  });
});

flow("PLT-8", { domain: "platform", routes: ["PATCH /v1/platform/api-keys/:keyId/revoke"] }, async (ctx) => {
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .patch("/v1/platform/api-keys/:keyId/revoke", {}, { params: { keyId: UNKNOWN_KEY_ID } });
    r.status(401);
  });
  await ctx.step("unknown keyId → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .patch("/v1/platform/api-keys/:keyId/revoke", {}, { params: { keyId: UNKNOWN_KEY_ID } });
    r.status(404);
  });
});

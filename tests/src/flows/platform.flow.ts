/**
 * Platform — public platform meta + sandbox version surface, plus the
 * sandbox-scoped api-keys CRUD. Maps to spec §… (PLT-*).
 *
 * Contract notes (verified against apps/api/src/platform):
 * - GET /v1/platform/ and GET /v1/platform/sandbox/version[/latest|/all|/changelog]
 *   are PUBLIC (no auth middleware) → 200 for OWNER and ANON alike.
 * - /v1/platform/api-keys/* is guarded by `supabaseAuth` → ANON → 401.
 *   The router is SANDBOX-scoped: GET needs a `sandbox_id` query param,
 *   POST needs `sandbox_id` in the body. Missing/non-UUID sandbox_id → 400.
 *   The :keyId mutation routes look the key up first → unknown keyId → 404.
 */
import { flow } from "../core/flow";

const UNKNOWN_KEY_ID = "00000000-0000-4000-a000-000000000000";

flow("PLT-1", { domain: "platform", tags: ["smoke"], routes: ["GET /v1/platform"] }, async (ctx) => {
  await ctx.step("platform meta is public → ok", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/platform");
    r.status(200).body().has("$.ok", true).has("$.message", "platform");
  });
  await ctx.step("ANON also sees it (public)", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/platform");
    r.status(200).body().has("$.ok", true);
  });
});

flow(
  "PLT-3",
  {
    domain: "platform",
    tags: ["smoke"],
    routes: [
      "GET /v1/platform/sandbox/version",
      "GET /v1/platform/sandbox/version/latest",
      "GET /v1/platform/sandbox/version/all",
      "GET /v1/platform/sandbox/version/changelog",
    ],
  },
  async (ctx) => {
    await ctx.step("running version → version + channel", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/platform/sandbox/version");
      r.status(200).body().exists("$.version").exists("$.channel");
    });
    await ctx.step("latest version (may hit GitHub/DockerHub)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/platform/sandbox/version/latest");
      r.status(200).body().exists("$.version").exists("$.channel");
    });
    await ctx.step("all versions → versions[] + current", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/platform/sandbox/version/all");
      r.status(200).body().exists("$.versions").exists("$.current");
    });
    await ctx.step("changelog → changelog[]", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/platform/sandbox/version/changelog");
      r.status(200).body().exists("$.changelog");
    });
    await ctx.step("version surface is public → ANON ok", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/platform/sandbox/version");
      r.status(200).body().exists("$.version");
    });
  },
);

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

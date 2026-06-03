/**
 * System / health + access gating — public routes, no auth, no fixtures.
 * Maps 1:1 to spec §0 (SYS-*) and §3 (ACC-*).
 */
import { flow } from "../core/flow";

flow("SYS-1", { domain: "system", tags: ["smoke", "health"], routes: ["GET /health", "GET /v1/health"] }, async (ctx) => {
  await ctx.step("GET /health", async () => {
    const r = await ctx.client.get("/health");
    r.status(200).body().has("$.status", "ok").has("$.service", "kortix-api").exists("$.version");
  });
  await ctx.step("GET /v1/health", async () => {
    const r = await ctx.client.get("/v1/health");
    r.status(200).body().has("$.status", "ok").has("$.service", "kortix-api");
  });
});

flow("SYS-4", { domain: "system", tags: ["smoke", "health"], routes: ["GET /v1/router/health"] }, async (ctx) => {
  await ctx.step("GET /v1/router/health", async () => {
    const r = await ctx.client.get("/v1/router/health");
    r.status(200).body().has("$.status", "ok").has("$.service", "kortix-router");
  });
});

flow("SYS-5", { domain: "system", tags: ["smoke"], routes: ["GET /v1/accounts/me"] }, async (ctx) => {
  await ctx.step("404 shape on unknown route", async () => {
    const r = await ctx.client.get("/v1/this-route-does-not-exist");
    r.status(404).body().has("$.error", true).has("$.message", "Not found").has("$.status", 404);
  });
  await ctx.step("protected route without auth → 401", async () => {
    const r = await ctx.client.get("/v1/accounts/me");
    r.status(401);
  });
});

flow("ACC-1", { domain: "access", tags: ["smoke"], routes: ["GET /v1/access/signup-status"] }, async (ctx) => {
  await ctx.step("GET /v1/access/signup-status", async () => {
    const r = await ctx.client.get("/v1/access/signup-status");
    r.status(200).body().exists("$.signupsEnabled");
  });
});

flow("ACC-2", { domain: "access", tags: [], routes: ["POST /v1/access/check-email"] }, async (ctx) => {
  await ctx.step("POST /v1/access/check-email (missing email) → 400", async () => {
    const r = await ctx.client.post("/v1/access/check-email", {});
    r.status(400);
  });
  await ctx.step("POST /v1/access/check-email (valid) → 200", async () => {
    const r = await ctx.client.post("/v1/access/check-email", { email: `probe-${Date.now()}@ke2e.kortix.test` });
    r.status(200).body().exists("$.allowed");
  });
});

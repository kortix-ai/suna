/**
 * Platform ops surface (apps/api/src/ops/index.ts, mounted at /v1/ops).
 * Guarded by supabaseAuth + requireAdmin (platform admin/super_admin).
 * The e2e OWNER is a normal user (not a platform admin), so we assert the
 * auth boundary: ANON → 401, non-admin OWNER → 403. Maps to spec OPS-*.
 */
import { flow } from "../core/flow";
import type { Identity } from "../core/client";

flow("OPS-1", { domain: "ops", routes: ["GET /v1/ops/overview"] }, async (ctx) => {
  await ctx.step("overview: ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/ops/overview");
    r.status(401);
  });
  await ctx.step("overview: non-admin OWNER → 403", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/ops/overview");
    r.status(403);
  });
});

flow(
  "ADM-1",
  {
    domain: "ops",
    requires: ["admin"],
    routes: [
      "GET /v1/admin/api/accounts",
      "GET /v1/admin/api/accounts/:id/users",
      "GET /v1/admin/api/accounts/:id/ledger",
      "POST /v1/admin/api/accounts/:id/credits",
      "POST /v1/admin/api/accounts/:id/credits/debit",
    ],
  },
  async (ctx) => {
    const platformAdmin: Identity = {
      label: "PLATFORM_ADMIN",
      auth: { mode: "bearer", token: ctx.env.adminToken! },
    };
    const accountId = ctx.P.accountId;

    await ctx.step("admin accounts: non-admin OWNER → 403", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/admin/api/accounts");
      r.status(403);
    });
    await ctx.step("admin accounts: platform admin lists accounts → 200", async () => {
      const r = await ctx.client.as(platformAdmin).get("/v1/admin/api/accounts", { query: { limit: 1 } });
      r.status(200).body().exists("$.accounts");
    });
    await ctx.step("admin account users → 200", async () => {
      const r = await ctx.client.as(platformAdmin).get("/v1/admin/api/accounts/:id/users", { params: { id: accountId } });
      r.status(200).body().exists("$.users");
    });
    await ctx.step("admin account ledger → 200", async () => {
      const r = await ctx.client.as(platformAdmin).get("/v1/admin/api/accounts/:id/ledger", { params: { id: accountId } });
      r.status(200).body().exists("$.entries");
    });
    await ctx.step("admin credit grant rejects zero amount → 400", async () => {
      const r = await ctx.client.as(platformAdmin).post(
        "/v1/admin/api/accounts/:id/credits",
        { amount: 0, description: "ke2e no-op" },
        { params: { id: accountId } },
      );
      r.status(400);
    });
    await ctx.step("admin credit debit rejects zero amount → 400", async () => {
      const r = await ctx.client.as(platformAdmin).post(
        "/v1/admin/api/accounts/:id/credits/debit",
        { amount: 0, description: "ke2e no-op" },
        { params: { id: accountId } },
      );
      r.status(400);
    });
  },
);

/**
 * Platform ops surface (apps/api/src/ops/index.ts, mounted at /v1/ops).
 * Guarded by supabaseAuth + requireAdmin (platform admin/super_admin).
 * The e2e OWNER is a normal user (not a platform admin), so we assert the
 * auth boundary: ANON → 401, non-admin OWNER → 403. Maps to spec OPS-*.
 */
import { flow } from "../core/flow";

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

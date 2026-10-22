/**
 * Platform ops surface (apps/api/src/ops/index.ts, mounted at /v1/ops).
 * Guarded by supabaseAuth + requireAdmin (platform admin/super_admin).
 * ANON → 401, non-admin OWNER → 403; with the platform-admin capability the
 * 200 body is asserted section by section. Maps to spec OPS-*.
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
  if (ctx.env.capabilities.admin) {
    await ctx.step("overview: platform admin → 200 with every section populated and derived counts consistent", async () => {
      const r = await ctx.client.withBearer(ctx.env.adminToken!, "ADMIN_TOKEN").get("/v1/ops/overview");
      r.status(200)
        .body()
        .has("$.api.status", "ok")
        .exists("$.api.env")
        .exists("$.api.tunnel")
        .has("$.queues.trigger_events_by_status", {})
        .has("$.queues.channel_events_by_status", {})
        .has("$.queues.queued_total", 0)
        .has("$.observability.structured_request_logs_enabled", true)
        .has("$.observability.trace_headers_enabled", true)
        .matches("$.generated_at", /^\d{4}-\d{2}-\d{2}T/);
      const body = r.json<any>();
      // On a healthy DB no aggregate degrades: a null here means a query failed.
      const numbers = {
        accounts: body.totals.accounts,
        projects: body.totals.projects,
        audit_events_24h: body.audit.events_24h,
        calls_24h: body.usage.calls_24h,
        cost_usd_24h: body.usage.cost_usd_24h,
      };
      for (const [name, value] of Object.entries(numbers)) {
        if (typeof value !== "number" || value < 0) throw new Error(`${name}: expected a non-negative number, got ${JSON.stringify(value)}`);
      }
      if (body.totals.accounts < 1) throw new Error("this run created accounts, but totals.accounts < 1");
      if (!Array.isArray(body.audit.recent) || body.audit.recent.length > 10) {
        throw new Error(`audit.recent must be an array of at most 10, got ${JSON.stringify(body.audit.recent)}`);
      }
      const providerCalls = (body.usage.last_24h_by_provider as Array<{ calls: number }>).reduce((s, row) => s + row.calls, 0);
      if (providerCalls !== body.usage.calls_24h) throw new Error(`calls_24h ${body.usage.calls_24h} != per-provider sum ${providerCalls}`);
      if (body.sessions.errored !== (body.sessions.by_status.failed ?? 0)) throw new Error("sessions.errored != by_status.failed");
    });
  }
});

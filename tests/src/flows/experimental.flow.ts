/**
 * Experimental features — the unified per-project feature-flag surface.
 * Maps to spec §EXP-*.
 *
 * `PATCH /v1/projects/:projectId/experimental {feature, enabled}` is the single
 * write path for opting a project into an experimental feature (apps,
 * agent_tunnel, …). State is DB-only (projects.metadata.experimental). The
 * response is the serialized project, which carries `experimental` (effective
 * map) and `experimental_features` (the self-describing catalog the UI renders).
 *
 * Not behind any feature gate — it's how a project opts in — so it's always
 * reachable for a project editor / account owner/admin. See apps.flow.ts §APP-4 for the legacy /apps-config
 * alias.
 */
import { flow } from "../core/flow";

flow(
  "EXP-1",
  {
    domain: "projects",
    tags: ["experimental"],
    routes: ["PATCH /v1/projects/:projectId/experimental"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step("OWNER enables agent_tunnel → 200 + catalog in body", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/experimental",
          { feature: "agent_tunnel", enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(200).body().exists("$.experimental_features").exists("$.experimental");
    });

    await ctx.step("OWNER clears the override (enabled: null) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/experimental",
          { feature: "agent_tunnel", enabled: null },
          { params: { projectId: p.id } },
        );
      r.status(200);
    });

    // meet uses the same write path + reconciles the kortix_meet channel connector.
    // Assert structure (not the effective value — that depends on MEET_ENABLED on the
    // target), then clear it.
    await ctx.step("OWNER enables meet → 200 + catalog in body", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/experimental",
          { feature: "meet", enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(200).body().exists("$.experimental_features").exists("$.experimental");
    });

    await ctx.step("OWNER clears the meet override (enabled: null) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/experimental",
          { feature: "meet", enabled: null },
          { params: { projectId: p.id } },
        );
      r.status(200);
    });

    await ctx.step("unknown feature → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/experimental",
          { feature: "not_a_feature", enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("non-bool enabled → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/experimental",
          { feature: "apps", enabled: "yes" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch(
          "/v1/projects/:projectId/experimental",
          { feature: "apps", enabled: true },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          "/v1/projects/:projectId/experimental",
          { feature: "apps", enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
  },
);

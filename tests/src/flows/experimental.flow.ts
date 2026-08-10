/**
 * Feature flags — the unified per-project flag surface. Maps to spec §EXP-*.
 *
 * `PATCH /v1/projects/:workspaceId/features {feature, enabled}` is the canonical
 * write path for opting a project into a flag (agent_tunnel, review_center, …);
 * `PATCH /v1/projects/:workspaceId/experimental` is the deprecated alias published
 * SDKs still call, registered on the SAME handler. State is DB-only
 * (projects.metadata.experimental — a stable storage detail). The response is
 * the serialized project, which carries `experimental` (effective map) and
 * `experimental_features` (the self-describing catalog the UI renders); both
 * wire names are historical and stable.
 *
 * Not behind any flag itself — it's how a project opts in — so it's always
 * reachable for a project editor / account owner/admin.
 */
import { flow } from "../core/flow";

flow(
  "EXP-1",
  {
    domain: "projects",
    tags: ["experimental", "feature-flags"],
    routes: [
      "PATCH /v1/projects/:workspaceId/features",
      "PATCH /v1/projects/:workspaceId/experimental",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step("OWNER enables agent_tunnel via /features → 200 + catalog in body", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/features",
          { feature: "agent_tunnel", enabled: true },
          { params: { workspaceId: p.id } },
        );
      r.status(200).body().exists("$.experimental_features").exists("$.experimental");
    });

    await ctx.step("the deprecated /experimental alias writes the same state → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/experimental",
          { feature: "agent_tunnel", enabled: false },
          { params: { workspaceId: p.id } },
        );
      r.status(200).body().exists("$.experimental_features").exists("$.experimental");
    });

    await ctx.step("OWNER clears the override (enabled: null) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/features",
          { feature: "agent_tunnel", enabled: null },
          { params: { workspaceId: p.id } },
        );
      r.status(200);
    });

    // meet uses the same write path + reconciles the kortix_voice channel connector.
    // Assert structure (not the effective value — that depends on the project's own
    // target), then clear it.
    await ctx.step("OWNER enables meet → 200 + catalog in body", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/experimental",
          { feature: "voice", enabled: true },
          { params: { workspaceId: p.id } },
        );
      r.status(200).body().exists("$.experimental_features").exists("$.experimental");
    });

    await ctx.step("OWNER clears the meet override (enabled: null) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/experimental",
          { feature: "voice", enabled: null },
          { params: { workspaceId: p.id } },
        );
      r.status(200);
    });

    await ctx.step("unknown feature → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/experimental",
          { feature: "not_a_feature", enabled: true },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("non-bool enabled → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:workspaceId/experimental",
          { feature: "apps", enabled: "yes" },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch(
          "/v1/projects/:workspaceId/experimental",
          { feature: "apps", enabled: true },
          { params: { workspaceId: p.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          "/v1/projects/:workspaceId/experimental",
          { feature: "apps", enabled: true },
          { params: { workspaceId: p.id } },
        );
      r.status(401);
    });
  },
);

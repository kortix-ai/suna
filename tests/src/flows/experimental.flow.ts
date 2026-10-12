/**
 * Feature flags — the unified per-project flag surface. Maps to spec §EXP-*.
 *
 * `PATCH /v1/projects/:projectId/features {feature, enabled}` is the canonical
 * write path for opting a project into a flag (connectors_api_discover, apps, …);
 * `PATCH /v1/projects/:projectId/experimental` is the deprecated alias published
 * SDKs still call, registered on the SAME handler. State is DB-only
 * (projects.metadata.experimental — a stable storage detail). The response is
 * the serialized project, which carries `experimental` (effective map) and
 * `experimental_features` (the self-describing catalog the UI renders); both
 * wire names are historical and stable.
 *
 * Not behind any flag itself — it's how a project opts in — so it's always
 * reachable for a project editor / account owner/admin.
 */
import { flow } from '../core/flow';

flow(
  'EXP-1',
  {
    domain: 'projects',
    tags: ['experimental', 'feature-flags'],
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'PATCH /v1/projects/:projectId/experimental',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step('OWNER enables connectors_api_discover via /features → 200 + catalog in body', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/features',
          { feature: 'connectors_api_discover', enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(200).body().exists('$.experimental_features').exists('$.experimental');
    });

    await ctx.step('the deprecated /experimental alias writes the same state → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/experimental',
          { feature: 'connectors_api_discover', enabled: false },
          { params: { projectId: p.id } },
        );
      r.status(200).body().exists('$.experimental_features').exists('$.experimental');
    });

    await ctx.step('OWNER clears the override (enabled: null) → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/features',
          { feature: 'connectors_api_discover', enabled: null },
          { params: { projectId: p.id } },
        );
      r.status(200);
    });

    await ctx.step('agent_tunnel graduated (computers need no flag) → 400 unknown feature', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/features',
          { feature: 'agent_tunnel', enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step('pi_worker withdrawn (pi runs only in the sandbox) → 400, absent from the catalog', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/features',
          { feature: 'pi_worker', enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(400);
      const project = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/features',
          { feature: 'pi_harness', enabled: null },
          { params: { projectId: p.id } },
        );
      project.status(200);
      const body = project.json<{
        experimental: Record<string, boolean>;
        experimental_features: Array<{ key: string }>;
      }>();
      if ('pi_worker' in body.experimental) throw new Error('experimental still carries pi_worker');
      if (body.experimental_features.some((f) => f.key === 'pi_worker')) {
        throw new Error('the catalog still lists pi_worker');
      }
      if (!body.experimental_features.some((f) => f.key === 'pi_harness')) {
        throw new Error('the catalog lost pi_harness');
      }
    });

    await ctx.step('unknown feature → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/experimental',
          { feature: 'not_a_feature', enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step('non-bool enabled → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/experimental',
          { feature: 'apps', enabled: 'yes' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch(
          '/v1/projects/:projectId/experimental',
          { feature: 'apps', enabled: true },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          '/v1/projects/:projectId/experimental',
          { feature: 'apps', enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
  },
);

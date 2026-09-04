/**
 * Monitoring — the session stage board (docs/monitoring.md). Maps to spec §11c (MON-1..5).
 *
 * `PUT /sessions/:sid/stage` is the only writer of `metadata.stage`. The flag
 * gate sits after membership authz and before the session lookup, so every
 * negative path except MON-1 runs in the local profile against a random
 * session id; MON-1 needs a real session and is gated on `daytona`+`funded`.
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';

const RANDOM_UUID = '00000000-0000-4000-a000-0000000000e1';
const FEATURES = 'PATCH /v1/projects/:projectId/features';
const STAGE = 'PUT /v1/projects/:projectId/sessions/:sessionId/stage';

async function enableMonitoring(ctx: FlowContext, projectId: string) {
  await ctx.step('OWNER enables Monitoring for the project → 200', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .patch('/v1/projects/:projectId/features', { feature: 'monitoring', enabled: true }, {
        params: { projectId },
      });
    r.status(200);
  });
}

flow(
  'MON-1',
  {
    domain: 'monitoring',
    requires: ['daytona', 'funded'],
    timeoutMs: 300_000,
    routes: [FEATURES, STAGE, 'GET /v1/projects/:projectId/sessions/:sessionId'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    await enableMonitoring(ctx, p.id);
    const s = await ctx.fixtures.session(p);
    await ctx.step(
      'OWNER (a person, not the session agent) tries to park the card in Ready → 403 stage_agent_only',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .put(
            '/v1/projects/:projectId/sessions/:sessionId/stage',
            { stage: 'ready', needs_approval: true, note: 'Plan in PLAN.md' },
            { params: { projectId: p.id, sessionId: s.id } },
          );
        r.status(403).body().has('$.code', 'stage_agent_only');
      },
    );
    await ctx.step('read-back: the card did not move (stage stays null → Backlog)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId', {
          params: { projectId: p.id, sessionId: s.id },
        });
      r.status(200).body().has('$.stage', null);
    });
  },
);

flow('MON-2', { domain: 'monitoring', tags: ['smoke'], routes: [STAGE] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step('flag off → 403 feature_disabled, before any session lookup', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .put(
        '/v1/projects/:projectId/sessions/:sessionId/stage',
        { stage: 'ready' },
        { params: { projectId: p.id, sessionId: RANDOM_UUID } },
      );
    r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'monitoring');
  });
});

flow('MON-3', { domain: 'monitoring', routes: [FEATURES, STAGE] }, async (ctx) => {
  const p = await ctx.fixtures.sharedProject();
  await enableMonitoring(ctx, p.id);
  const put = (body: unknown) =>
    ctx.client
      .as(ctx.P.OWNER)
      .put('/v1/projects/:projectId/sessions/:sessionId/stage', body, {
        params: { projectId: p.id, sessionId: RANDOM_UUID },
      });
  await ctx.step('invalid stage → 400', async () => {
    (await put({ stage: 'shipped' })).status(400).body().has('$.error', 'Invalid stage');
  });
  await ctx.step('note longer than 500 chars → 400', async () => {
    (await put({ stage: 'ready', note: 'x'.repeat(501) })).status(400);
  });
  await ctx.step('non-boolean needs_approval → 400', async () => {
    (await put({ stage: 'ready', needs_approval: 'yes' })).status(400);
  });
  await ctx.step('non-uuid session id → 400', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .put('/v1/projects/:projectId/sessions/:sessionId/stage', { stage: 'ready' }, {
        params: { projectId: p.id, sessionId: 'not-a-uuid' },
      });
    r.status(400);
  });
  await ctx.step('valid body but unknown session → 404', async () => {
    (await put({ stage: 'ready' })).status(404);
  });
});

flow(
  'MON-4',
  { domain: 'monitoring', routes: ['PATCH /v1/projects/:projectId/sessions/:sessionId'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('PATCH metadata.stage → 400 server-managed', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/sessions/:sessionId',
          { metadata: { stage: { value: 'done' } } },
          { params: { projectId: p.id, sessionId: RANDOM_UUID } },
        );
      r.status(400).body().has('$.error', 'metadata key is server-managed: stage');
    });
  },
);

flow('MON-5', { domain: 'monitoring', routes: [STAGE] }, async (ctx) => {
  const p = await ctx.fixtures.sharedProject();
  await ctx.step('NONMEMBER → 403/404', async () => {
    const r = await ctx.client
      .as(ctx.P.NONMEMBER)
      .put('/v1/projects/:projectId/sessions/:sessionId/stage', { stage: 'ready' }, {
        params: { projectId: p.id, sessionId: RANDOM_UUID },
      });
    r.status([403, 404]);
  });
  await ctx.step('ANON → 401', async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .put('/v1/projects/:projectId/sessions/:sessionId/stage', { stage: 'ready' }, {
        params: { projectId: p.id, sessionId: RANDOM_UUID },
      });
    r.status(401);
  });
});

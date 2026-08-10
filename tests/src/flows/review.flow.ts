/**
 * Review Center — per-project human-in-the-loop inbox. Maps to spec §11b (RV-1..6).
 *
 * Scope: native items (output/decision/batch). We assert the read endpoints, the
 * submit + act + bulk validation surfaces, and the access boundaries — all against
 * real handlers, without creating durable rows (validation paths only, like the
 * change-requests flow). Unknown :reviewItemId → 404; bad enums → 400.
 */
import { flow } from '../core/flow';

const RANDOM_UUID = '00000000-0000-4000-a000-0000000000d1';

flow(
  'RV-1',
  { domain: 'review', tags: ['smoke'], routes: ['GET /v1/projects/:workspaceId/review/items'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('OWNER lists review items → 200 with envelope', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:workspaceId/review/items', { params: { workspaceId: p.id } });
      r.status(200).body().exists('$.review_items');
    });
    await ctx.step('invalid segment → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:workspaceId/review/items', {
        params: { workspaceId: p.id },
        query: { segment: 'soon' },
      });
      r.status(400);
    });
    await ctx.step('invalid kind → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:workspaceId/review/items', {
        params: { workspaceId: p.id },
        query: { kind: 'wizard' },
      });
      r.status(400);
    });
  },
);

flow(
  'RV-2',
  { domain: 'review', routes: ['GET /v1/projects/:workspaceId/review/items/:reviewItemId'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('unknown reviewItemId → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:workspaceId/review/items/:reviewItemId', {
          params: { workspaceId: p.id, reviewItemId: RANDOM_UUID },
        });
      r.status(404);
    });
  },
);

flow(
  'RV-3',
  { domain: 'review', routes: ['POST /v1/projects/:workspaceId/review/items'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('missing title → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:workspaceId/review/items',
          { kind: 'output' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('non-submittable kind (change) → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:workspaceId/review/items',
          { kind: 'change', title: ctx.fixtures.name('rv') },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('invalid risk → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:workspaceId/review/items',
          { kind: 'output', title: ctx.fixtures.name('rv'), risk: 'nuclear' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
  },
);

flow(
  'RV-4',
  { domain: 'review', routes: ['POST /v1/projects/:workspaceId/review/items/:reviewItemId/act'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('invalid verdict → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:workspaceId/review/items/:reviewItemId/act',
          { verdict: 'merge' },
          { params: { workspaceId: p.id, reviewItemId: RANDOM_UUID } },
        );
      r.status(400);
    });
    await ctx.step('valid verdict on unknown id → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:workspaceId/review/items/:reviewItemId/act',
          { verdict: 'approve' },
          { params: { workspaceId: p.id, reviewItemId: RANDOM_UUID } },
        );
      r.status(404);
    });
  },
);

flow(
  'RV-5',
  { domain: 'review', routes: ['POST /v1/projects/:workspaceId/review/bulk'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('missing ids → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:workspaceId/review/bulk',
          { verdict: 'approve' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('invalid verdict → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:workspaceId/review/bulk',
          { ids: [RANDOM_UUID], verdict: 'merge' },
          { params: { workspaceId: p.id } },
        );
      r.status(400);
    });
  },
);

flow(
  'RV-6',
  { domain: 'review', routes: ['GET /v1/projects/:workspaceId/review/items'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('NONMEMBER cannot list → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:workspaceId/review/items', { params: { workspaceId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step('ANON cannot list → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:workspaceId/review/items', { params: { workspaceId: p.id } });
      r.status(401);
    });
  },
);

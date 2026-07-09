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
  { domain: 'review', tags: ['smoke'], routes: ['GET /v1/projects/:projectId/review/items'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('OWNER lists review items → 200 with envelope', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/review/items', { params: { projectId: p.id } });
      r.status(200).body().exists('$.review_items');
    });
    await ctx.step('invalid segment → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/review/items', {
        params: { projectId: p.id },
        query: { segment: 'soon' },
      });
      r.status(400);
    });
    await ctx.step('invalid kind → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/review/items', {
        params: { projectId: p.id },
        query: { kind: 'wizard' },
      });
      r.status(400);
    });
  },
);

flow(
  'RV-2',
  { domain: 'review', routes: ['GET /v1/projects/:projectId/review/items/:reviewItemId'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('unknown reviewItemId → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/review/items/:reviewItemId', {
          params: { projectId: p.id, reviewItemId: RANDOM_UUID },
        });
      r.status(404);
    });
  },
);

flow(
  'RV-3',
  {
    domain: 'review',
    routes: [
      'POST /v1/projects/:projectId/review/items',
      'POST /v1/projects/:projectId/review/items/:reviewItemId/act',
      'PATCH /v1/projects/:projectId/experimental',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('missing title → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/review/items',
          { kind: 'output' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('non-submittable kind (change) → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/review/items',
          { kind: 'change', title: ctx.fixtures.name('rv') },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('invalid risk → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/review/items',
          { kind: 'output', title: ctx.fixtures.name('rv'), risk: 'nuclear' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    // Structured work submissions (submission_version payloads) are gated behind
    // the work_submission experimental flag. Start from a known-off state.
    await ctx.step('disable work_submission → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/experimental',
        { feature: 'work_submission', enabled: false },
        { params: { projectId: p.id } },
      );
      r.status(200);
    });
    await ctx.step('structured submit while work_submission disabled → 403', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/items',
        {
          kind: 'output',
          title: ctx.fixtures.name('rv'),
          detail: { submission_version: 1, storage: 'inline', content: 'gated' },
        },
        { params: { projectId: p.id } },
      );
      r.status(403);
    });
    await ctx.step('enable work_submission → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/experimental',
        { feature: 'work_submission', enabled: true },
        { params: { projectId: p.id } },
      );
      r.status(200);
    });
    await ctx.step('structured submit: server-owned detail.trace → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/items',
        {
          kind: 'output',
          title: ctx.fixtures.name('rv'),
          detail: { submission_version: 1, storage: 'inline', content: 'x', trace: { audit: [] } },
        },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });
    await ctx.step('structured submit: malformed git sha → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/items',
        {
          kind: 'output',
          title: ctx.fixtures.name('rv'),
          detail: {
            submission_version: 1,
            storage: 'git',
            git: { commit_sha: 'abc123', files: [{ path: 'out/report.md' }] },
          },
        },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });
    await ctx.step('structured submit: traversal file path → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/items',
        {
          kind: 'output',
          title: ctx.fixtures.name('rv'),
          detail: {
            submission_version: 1,
            storage: 'git',
            git: { commit_sha: 'a'.repeat(40), files: [{ path: '../escape.md' }] },
          },
        },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });
    await ctx.step('structured submit: sha not on the project remote → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/items',
        {
          kind: 'output',
          title: ctx.fixtures.name('rv'),
          detail: {
            submission_version: 1,
            storage: 'git',
            git: { commit_sha: 'a'.repeat(40), files: [{ path: 'out/report.md' }] },
          },
        },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });
    await ctx.step('structured submit: inline → 201 echoing storage, then dismissed', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/items',
        {
          kind: 'output',
          title: ctx.fixtures.name('rv'),
          detail: {
            submission_version: 1,
            storage: 'inline',
            content: 'All checks passed.',
            claims: ['ran against live data'],
          },
        },
        { params: { projectId: p.id } },
      );
      r.status(201).body().exists('$.review_item_id');
      r.body().has('$.detail.storage', 'inline');
      const created = r.json<{ review_item_id: string }>();
      // Keep the shared inbox clean — this flow must not leave durable rows.
      const dismissed = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/items/:reviewItemId/act',
        { verdict: 'dismiss' },
        { params: { projectId: p.id, reviewItemId: created.review_item_id } },
      );
      dismissed.status(200);
    });
    await ctx.step('clear work_submission override → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/experimental',
        { feature: 'work_submission', enabled: null },
        { params: { projectId: p.id } },
      );
      r.status(200);
    });
  },
);

flow(
  'RV-4',
  { domain: 'review', routes: ['POST /v1/projects/:projectId/review/items/:reviewItemId/act'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('invalid verdict → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/review/items/:reviewItemId/act',
          { verdict: 'merge' },
          { params: { projectId: p.id, reviewItemId: RANDOM_UUID } },
        );
      r.status(400);
    });
    await ctx.step('valid verdict on unknown id → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/review/items/:reviewItemId/act',
          { verdict: 'approve' },
          { params: { projectId: p.id, reviewItemId: RANDOM_UUID } },
        );
      r.status(404);
    });
  },
);

flow(
  'RV-5',
  { domain: 'review', routes: ['POST /v1/projects/:projectId/review/bulk'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('missing ids → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/review/bulk',
          { verdict: 'approve' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step('invalid verdict → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/review/bulk',
          { ids: [RANDOM_UUID], verdict: 'merge' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
  },
);

flow(
  'RV-6',
  { domain: 'review', routes: ['GET /v1/projects/:projectId/review/items'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('NONMEMBER cannot list → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/review/items', { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step('ANON cannot list → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/review/items', { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

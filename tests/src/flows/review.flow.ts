/**
 * Review Center — per-project human-in-the-loop inbox. Maps to spec §11b (RV-1..6).
 *
 * Scope: native items (output/decision/batch). We assert the read endpoints, the
 * submit + act + bulk validation surfaces, and the access boundaries — all against
 * real handlers, without creating durable rows (validation paths only, like the
 * change-requests flow). Unknown :reviewItemId → 404; bad enums → 400.
 *
 * Review Center is on for every project: no step enables a feature flag first,
 * and RV-1 pins that `review_center` is no longer a flag the API accepts.
 */
import { assert } from '../core/expect';
import { flow } from '../core/flow';

const RANDOM_UUID = '00000000-0000-4000-a000-0000000000d1';

function check(description: string, pass: boolean, expected: unknown, actual: unknown): void {
  assert({ kind: 'review', description, expected, actual, pass });
}

interface ReviewRow {
  review_item_id: string;
  status: string;
}

flow(
  'RV-1',
  {
    domain: 'review',
    tags: ['smoke'],
    routes: [
      'PATCH /v1/projects/:projectId/features',
      'GET /v1/projects/:projectId/review/items',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('Review Center is not a feature flag: toggling review_center → 400 unknown flag', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/features',
        { feature: 'review_center', enabled: false },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });
    await ctx.step('OWNER lists review items with no flag override → 200 with envelope', async () => {
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
  {
    domain: 'review',
    routes: [
      'GET /v1/projects/:projectId/review/items/:reviewItemId',
    ],
  },
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
  },
);

flow(
  'RV-4',
  {
    domain: 'review',
    routes: [
      'POST /v1/projects/:projectId/review/items/:reviewItemId/act',
    ],
  },
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
  {
    domain: 'review',
    routes: [
      'POST /v1/projects/:projectId/review/bulk',
    ],
  },
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

// KRTX-2316: the always-mounted badges read counts, not the inbox.
flow(
  'RV-7',
  {
    domain: 'review',
    routes: [
      'GET /v1/projects/:projectId/review/summary',
      'POST /v1/projects/:projectId/review/items',
      'POST /v1/projects/:projectId/review/items/:reviewItemId/act',
      'GET /v1/projects/:projectId/review/items',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ name: ctx.fixtures.name('rv7') });
    const summary = async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/review/summary', { params: { projectId: p.id } });
      r.status(200);
      return { body: r.json<{ needs_you_total: number; needs_you_by_session: Record<string, number> }>(), bytes: r.text().length };
    };
    await ctx.step('an empty inbox → 200 {needs_you_total: 0, needs_you_by_session: {}}', async () => {
      const { body } = await summary();
      check('zero counts', body.needs_you_total === 0 && Object.keys(body.needs_you_by_session).length === 0, { needs_you_total: 0, needs_you_by_session: {} }, body);
    });
    const ids: string[] = [];
    await ctx.step('OWNER submits 3 items → 201 each', async () => {
      for (const kind of ['output', 'decision', 'batch']) {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/review/items',
          { kind, title: ctx.fixtures.name(`rv7-${kind}`) },
          { params: { projectId: p.id } },
        );
        r.status(201);
        ids.push(r.json<{ review_item_id: string }>().review_item_id);
      }
    });
    await ctx.step('the summary counts the 3 → needs_you_total 3; items with no session count in the total only', async () => {
      const { body, bytes } = await summary();
      check('needs_you_total', body.needs_you_total === 3, 3, body.needs_you_total);
      check('no session keys', Object.keys(body.needs_you_by_session).length === 0, {}, body.needs_you_by_session);
      check('under 2 KB', bytes < 2_048, '< 2048', bytes);
    });
    await ctx.step('approving one → needs_you_total 2, equal to the needs_you segment of the list', async () => {
      const act = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/items/:reviewItemId/act',
        { verdict: 'approve' },
        { params: { projectId: p.id, reviewItemId: ids[0] } },
      );
      act.status(200).body().has('$.status', 'approved');
      const { body } = await summary();
      check('needs_you_total', body.needs_you_total === 2, 2, body.needs_you_total);
      const list = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/review/items', {
        params: { projectId: p.id },
        query: { segment: 'needs_you' },
      });
      list.status(200);
      const rows = list.json<{ review_items: ReviewRow[] }>().review_items;
      check('list and summary agree', rows.length === body.needs_you_total, body.needs_you_total, rows.length);
    });
    await ctx.step('NONMEMBER → 403/404; ANON → 401', async () => {
      const outsider = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/review/summary', { params: { projectId: p.id } });
      outsider.status([403, 404]);
      const anon = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/review/summary', { params: { projectId: p.id } });
      anon.status(401);
    });
  },
);

// KRTX-2316: the inbox is bounded: one page, a cursor, a ceiling.
flow(
  'RV-8',
  {
    domain: 'review',
    routes: [
      'POST /v1/projects/:projectId/review/items',
      'POST /v1/projects/:projectId/review/bulk',
      'GET /v1/projects/:projectId/review/items',
      'GET /v1/projects/:projectId/review/items/:reviewItemId',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project({ name: ctx.fixtures.name('rv8') });
    const ids: string[] = [];
    await ctx.step('OWNER submits 5 items and dismisses 2 → 3 Needs you, 2 Done', async () => {
      for (let i = 0; i < 5; i += 1) {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/review/items',
          { kind: 'output', title: ctx.fixtures.name(`rv8-${i}`) },
          { params: { projectId: p.id } },
        );
        r.status(201);
        ids.push(r.json<{ review_item_id: string }>().review_item_id);
      }
      const bulk = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/review/bulk',
        { ids: ids.slice(0, 2), verdict: 'dismiss' },
        { params: { projectId: p.id } },
      );
      bulk.status(200).body().has('$.updated', 2);
    });
    await ctx.step('limit=2 pages through all 5 once: Needs you first, then Done; the last page has next_cursor null', async () => {
      const seen: ReviewRow[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/review/items', {
          params: { projectId: p.id },
          query: cursor ? { limit: '2', cursor } : { limit: '2' },
        });
        r.status(200);
        const body = r.json<{ review_items: ReviewRow[]; next_cursor: string | null }>();
        check('page size ≤ 2', body.review_items.length <= 2, '<= 2', body.review_items.length);
        seen.push(...body.review_items);
        cursor = body.next_cursor;
        if (!cursor) break;
      }
      check('cursor ended', cursor === null, null, cursor);
      const got = seen.map((row) => row.review_item_id);
      check('every item once', new Set(got).size === 5 && got.every((id) => ids.includes(id)), [...ids].sort(), [...got].sort());
      const order = seen.map((row) => row.status).join(',');
      const expected = 'needs_you,needs_you,needs_you,dismissed,dismissed';
      check('Needs you before Done', order === expected, expected, order);
    });
    await ctx.step('segment=done → the 2 dismissed items, next_cursor null', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/review/items', {
        params: { projectId: p.id },
        query: { segment: 'done' },
      });
      r.status(200).body().has('$.next_cursor', null);
      const rows = r.json<{ review_items: ReviewRow[] }>().review_items;
      check('2 done items', rows.length === 2 && rows.every((row) => row.status === 'dismissed'), 2, rows.length);
    });
    await ctx.step('limit above the 200 ceiling → 400; 200 → 200; 0, a word and a forged cursor → 400', async () => {
      const get = (query: Record<string, string>) =>
        ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/review/items', { params: { projectId: p.id }, query });
      (await get({ limit: '201' })).status(400);
      (await get({ limit: '200' })).status(200);
      (await get({ limit: '0' })).status(400);
      (await get({ limit: 'many' })).status(400);
      (await get({ cursor: 'not-a-cursor' })).status(400);
      (await get({ session_id: 'not-a-uuid' })).status(400);
    });
    await ctx.step('a native item reads by id, off any page → 200; a cr: id with no change request → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/review/items/:reviewItemId', {
        params: { projectId: p.id, reviewItemId: ids[0] },
      });
      r.status(200).body().has('$.review_item.review_item_id', ids[0]);
      const missing = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/review/items/:reviewItemId', {
        params: { projectId: p.id, reviewItemId: `cr:${RANDOM_UUID}` },
      });
      missing.status(404);
    });
  },
);

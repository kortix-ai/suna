/**
 * AGI — goals, tasks, observations, requests, liveness. Maps to spec §28 (AGI-*).
 *
 * The whole surface sits behind ONE experimental key, `agi`, and the gate answers
 * 404 rather than 403 (`requireAgiProject`): when the feature is off there are no
 * routes, so the surface must not exist. AGI-1 proves exactly that, in both
 * directions, on a project it toggles itself — every other flow here enables the
 * feature first and would otherwise be asserting against a 404 wall.
 *
 * Two things shape what is assertable black-box:
 *
 *   • Tasks, observations and requests are DATABASE state (spec R-3), so their
 *     full lifecycle is reachable over HTTP and is exercised end to end here.
 *   • Goals are AUTHORED state in `kortix.yaml` (R-6) applied by `kortix ship`.
 *     There is no HTTP write path for a manifest — by design — so a fixture
 *     project has no `goals:` block, and the goal routes are exercised for their
 *     gate, their empty-list contract, and their unknown-slug 404. The happy path
 *     (a real pushing goal) needs a manifest commit and lives in the API-level
 *     integration tests (`integration-agi-goals-http.test.ts`), which can seed
 *     one. Asserted here: the routes exist, are gated, and never 500.
 *
 * Every flow uses `ctx.fixtures.project()` rather than `sharedProject()`: these
 * flows mutate project metadata (the experimental flag) and write task rows.
 */
import { flow } from '../core/flow';

/** A well-formed uuid that resolves to nothing — proves the 404 comes from the
 *  lookup, not from the shape guard, which answers 404 for a malformed id too. */
const UNKNOWN_UUID = '00000000-0000-4000-a000-000000000000';

/** Turn `agi` on for a project. The single write path for every experimental
 *  feature, and the only reason the rest of this surface is reachable. */
async function enableAgi(ctx: any, projectId: string): Promise<void> {
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .patch(
      '/v1/projects/:projectId/experimental',
      { feature: 'agi', enabled: true },
      { params: { projectId } },
    );
  if (r.statusCode !== 200) throw new Error(`could not enable agi: ${r.statusCode} ${r.text()}`);
}

/** Create one task and return its id. `origin` is required with no default —
 *  who asked for a task is the one fact nobody downstream can reconstruct. */
async function createTask(
  ctx: any,
  projectId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const r = await ctx.client
    .as(ctx.P.OWNER)
    .post('/v1/projects/:projectId/agi/tasks', { origin: 'human', ...body }, {
      params: { projectId },
    });
  if (r.statusCode !== 201) throw new Error(`could not create task: ${r.statusCode} ${r.text()}`);
  return r.json().task.task_id;
}

// ─── AGI-1 — the `agi` gate: off means the surface does not exist ────────────

flow(
  'AGI-1',
  {
    domain: 'agi',
    tags: ['agi', 'experimental'],
    routes: [
      'GET /v1/projects/:projectId/agi/goals',
      'GET /v1/projects/:projectId/agi/tasks',
      'GET /v1/projects/:projectId/agi/liveness',
      'GET /v1/projects/:projectId/agi/requests',
      'PATCH /v1/projects/:projectId/experimental',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    // R-44. Not 403: a 403 would confirm the surface exists and is merely
    // forbidden. The project's OWNER gets the 404 too — it is about the feature,
    // never about the caller.
    await ctx.step('feature OFF → 404 on every AGI entry point', async () => {
      for (const path of [
        '/v1/projects/:projectId/agi/goals',
        '/v1/projects/:projectId/agi/tasks',
        '/v1/projects/:projectId/agi/liveness',
        '/v1/projects/:projectId/agi/requests',
      ] as const) {
        const r = await ctx.client.as(ctx.P.OWNER).get(path, { params: { projectId: p.id } });
        r.status(404);
      }
    });

    await ctx.step('enable agi → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/experimental',
          { feature: 'agi', enabled: true },
          { params: { projectId: p.id } },
        );
      r.status(200).body().exists('$.experimental');
    });

    await ctx.step('feature ON → 200 on every AGI entry point', async () => {
      const goals = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/goals', { params: { projectId: p.id } });
      goals.status(200).body().exists('$.goals').exists('$.errors');

      const tasks = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/tasks', { params: { projectId: p.id } });
      tasks.status(200).body().exists('$.tasks');

      const liveness = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/liveness', { params: { projectId: p.id } });
      liveness.status(200).body().exists('$.tasks').exists('$.goals');

      const requests = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/requests', { params: { projectId: p.id } });
      requests.status(200).body().exists('$.requests');
    });

    // The gate is checked LAST, after authz, so a caller who cannot reach the
    // project can never learn from the response which features it has on. With
    // `agi` now ON, a stranger must still be refused by the floor.
    await ctx.step('NONMEMBER → 403/404 even with the feature on', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/agi/tasks', { params: { projectId: p.id } });
      r.status([403, 404]);
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/agi/tasks', { params: { projectId: p.id } });
      r.status(401);
    });

    await ctx.step('clearing the override puts the surface back to 404', async () => {
      const cleared = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/projects/:projectId/experimental',
          { feature: 'agi', enabled: null },
          { params: { projectId: p.id } },
        );
      cleared.status(200);

      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/tasks', { params: { projectId: p.id } });
      r.status(404);
    });
  },
);

// ─── AGI-2 — the task lifecycle: create → read → patch → claim → release ────

flow(
  'AGI-2',
  {
    domain: 'agi',
    tags: ['agi', 'tasks'],
    routes: [
      'POST /v1/projects/:projectId/agi/tasks',
      'GET /v1/projects/:projectId/agi/tasks',
      'GET /v1/projects/:projectId/agi/tasks/:taskId',
      'PATCH /v1/projects/:projectId/agi/tasks/:taskId',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await enableAgi(ctx, p.id);

    let taskId = '';

    await ctx.step('create → 201 + created:true', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks',
        { title: 'Ship the oil desk', origin: 'human', priority: 'high', goal_slug: 'oil-desk' },
        { params: { projectId: p.id } },
      );
      r.status(201).body().has('$.created', true).has('$.task.priority', 'high');
      taskId = r.json().task.task_id;
    });

    // Origin has no default on purpose: guessing 'human' would corrupt the one
    // fact nobody downstream can reconstruct.
    await ctx.step('create without origin → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/agi/tasks',
          { title: 'No origin' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step('create without a title → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/agi/tasks',
          { origin: 'human' },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    // R-14: agent OR human, never both.
    await ctx.step('two assignees → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks',
        { title: 'Both', origin: 'human', agent: 'kortix-agi', assignee_user_id: UNKNOWN_UUID },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });

    await ctx.step('unknown parent → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks',
        { title: 'Orphan', origin: 'human', parent_id: UNKNOWN_UUID },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });

    // Idempotency is by origin_fingerprint, not by title: a daily push
    // re-deriving the same task must produce one row, not one per day.
    await ctx.step('same origin_fingerprint twice → 201 then 200 created:false', async () => {
      const body = {
        title: 'Fingerprinted',
        origin: 'session',
        origin_fingerprint: `e2e-${p.id.slice(0, 8)}-fp`,
      };
      const first = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/agi/tasks', body, { params: { projectId: p.id } });
      first.status(201).body().has('$.created', true);

      const second = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/agi/tasks', body, { params: { projectId: p.id } });
      second.status(200).body().has('$.created', false);
      second.body().has('$.task.task_id', first.json().task.task_id);
    });

    await ctx.step('list → 200 and the task is in it', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/tasks', { params: { projectId: p.id } });
      r.status(200).body().exists('$.tasks');
      const ids = r.json().tasks.map((t: any) => t.task_id);
      if (!ids.includes(taskId)) throw new Error('created task missing from the list');
    });

    await ctx.step('list with a bad filter → 400, never a silent full list', async () => {
      for (const query of [
        { status: 'not-a-status' },
        { priority: 'not-a-priority' },
        { limit: '0' },
        { ready: 'maybe' },
        { cursor: 'not-a-cursor' },
      ]) {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId/agi/tasks', { params: { projectId: p.id }, query });
        r.status(400);
      }
    });

    await ctx.step('detail → 200 with children + blockers', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/agi/tasks/:taskId', {
        params: { projectId: p.id, taskId },
      });
      r.status(200).body().has('$.task.task_id', taskId).exists('$.children').exists('$.blockers');
    });

    await ctx.step('detail on an unknown id → 404, and on a malformed id → 404', async () => {
      const unknown = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/tasks/:taskId', {
          params: { projectId: p.id, taskId: UNKNOWN_UUID },
        });
      unknown.status(404);

      const malformed = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/tasks/:taskId', {
          params: { projectId: p.id, taskId: 'not-a-uuid' },
        });
      malformed.status(404);
    });

    await ctx.step('patch status + body → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/agi/tasks/:taskId',
        { status: 'todo', body: 'Reason recorded by the e2e suite.' },
        { params: { projectId: p.id, taskId } },
      );
      r.status(200).body().has('$.task.status', 'todo');
    });

    await ctx.step('a task cannot block itself → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/agi/tasks/:taskId',
        { blocked_by: [taskId] },
        { params: { projectId: p.id, taskId } },
      );
      r.status(400);
    });

    await ctx.step('a task cannot parent itself → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/agi/tasks/:taskId',
        { parent_id: taskId },
        { params: { projectId: p.id, taskId } },
      );
      r.status(400);
    });

    await ctx.step('patch an unknown task → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        '/v1/projects/:projectId/agi/tasks/:taskId',
        { status: 'todo' },
        { params: { projectId: p.id, taskId: UNKNOWN_UUID } },
      );
      r.status(404);
    });

    await ctx.step('ANON → 401 on create', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          '/v1/projects/:projectId/agi/tasks',
          { title: 'x', origin: 'human' },
          { params: { projectId: p.id } },
        );
      r.status(401);
    });
  },
);

// ─── AGI-3 — claim/release: the one statement that decides the winner ────────

flow(
  'AGI-3',
  {
    domain: 'agi',
    tags: ['agi', 'tasks'],
    routes: [
      'POST /v1/projects/:projectId/agi/tasks/:taskId/claim',
      'POST /v1/projects/:projectId/agi/tasks/:taskId/release',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await enableAgi(ctx, p.id);
    const taskId = await createTask(ctx, p.id, { title: 'Contended work', status: 'todo' });

    const claimAs = (sessionId: string, body: Record<string, unknown> = {}) =>
      ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/claim',
        { session_id: sessionId, ...body },
        { params: { projectId: p.id, taskId } },
      );

    await ctx.step('claim → 200 claimed:true, status moves to doing', async () => {
      const r = await claimAs('e2e-session-a', { status: 'doing' });
      r.status(200).body().has('$.claimed', true).has('$.task.status', 'doing');
    });

    // R-18: the loser is told to pick different work, never to wait. The 409
    // carries the current holder so the caller can say why it lost.
    await ctx.step('a second session claiming the same task → 409 claim_conflict', async () => {
      const r = await claimAs('e2e-session-b');
      r.status(409).body().has('$.code', 'claim_conflict').exists('$.claim.session_id');
    });

    // Re-claiming as the SAME holder is a lease renewal, not a conflict.
    await ctx.step('the holder re-claiming renews its own lease → 200', async () => {
      const r = await claimAs('e2e-session-a');
      r.status(200).body().has('$.claimed', true);
    });

    await ctx.step('claim without a session_id → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/claim',
        {},
        { params: { projectId: p.id, taskId } },
      );
      r.status(400);
    });

    // Claiming into done/cancelled would take a lease and drop it in the same
    // statement — that is a PATCH, not a claim.
    await ctx.step('claim into a terminal status → 400', async () => {
      const r = await claimAs('e2e-session-a', { status: 'done' });
      r.status(400);
    });

    await ctx.step('claim with an out-of-range ttl_seconds → 400', async () => {
      const r = await claimAs('e2e-session-a', { ttl_seconds: 1 });
      r.status(400);
    });

    await ctx.step('release by a session that does not hold it → 409', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/release',
        { session_id: 'e2e-session-b' },
        { params: { projectId: p.id, taskId } },
      );
      r.status(409).body().has('$.code', 'claim_not_held');
    });

    await ctx.step('the holder releases → 200 released:true', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/release',
        { session_id: 'e2e-session-a', status: 'todo' },
        { params: { projectId: p.id, taskId } },
      );
      r.status(200).body().has('$.released', true).has('$.task.status', 'todo');
    });

    await ctx.step('releasing again → 409, the lease is already gone', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/release',
        { session_id: 'e2e-session-a' },
        { params: { projectId: p.id, taskId } },
      );
      r.status(409);
    });

    await ctx.step('claim/release on an unknown task → 404', async () => {
      const claim = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/claim',
        { session_id: 'e2e-session-a' },
        { params: { projectId: p.id, taskId: UNKNOWN_UUID } },
      );
      claim.status(404);

      const release = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/release',
        { session_id: 'e2e-session-a' },
        { params: { projectId: p.id, taskId: UNKNOWN_UUID } },
      );
      release.status(404);
    });
  },
);

// ─── AGI-4 — goals + observations (manifest-authored; see the header note) ───

flow(
  'AGI-4',
  {
    domain: 'agi',
    tags: ['agi', 'goals'],
    routes: [
      'GET /v1/projects/:projectId/agi/goals',
      'GET /v1/projects/:projectId/agi/goals/:slug',
      'POST /v1/projects/:projectId/agi/goals/:slug/push',
      'POST /v1/projects/:projectId/agi/goals/:slug/observations',
      'GET /v1/projects/:projectId/agi/goals/:slug/observations',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await enableAgi(ctx, p.id);

    // Goals are read out of kortix.yaml on every request — there is no cached
    // projection and no HTTP write path (R-6). A fixture project declares none,
    // so the list is empty and, critically, `errors` is still present: a
    // malformed goal is REPORTED, never omitted.
    await ctx.step('list → 200 with goals + errors, both arrays', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/goals', { params: { projectId: p.id } });
      r.status(200).body().has('$.goals', []).has('$.errors', []);
    });

    await ctx.step('an invalid ?status → 400, never a silently unfiltered list', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/agi/goals', {
        params: { projectId: p.id },
        query: { status: 'Active' },
      });
      r.status(400);
    });

    await ctx.step('each authored status is accepted → 200', async () => {
      for (const status of ['active', 'achieved', 'paused', 'abandoned']) {
        const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/agi/goals', {
          params: { projectId: p.id },
          query: { status },
        });
        r.status(200);
      }
    });

    await ctx.step('detail on a slug the manifest does not declare → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/agi/goals/:slug', {
        params: { projectId: p.id, slug: 'no-such-goal' },
      });
      r.status(404);
    });

    // A push is a manual trigger fire reached through its goal. No goal, no
    // trigger to fire — and it must not be a 500 or a silent 202.
    await ctx.step('push on an undeclared goal → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/goals/:slug/push',
        { reason: 'e2e' },
        { params: { projectId: p.id, slug: 'no-such-goal' } },
      );
      r.status(404);
    });

    await ctx.step('push with a non-string reason → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/goals/:slug/push',
        { reason: 42 },
        { params: { projectId: p.id, slug: 'no-such-goal' } },
      );
      r.status(400);
    });

    // R-12c. The manifest check is what stops a typo'd slug writing a series
    // nothing will ever read while the goal still reports as unmeasurable.
    await ctx.step('observe on an undeclared goal → 404, body validated first', async () => {
      const bad = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/goals/:slug/observations',
        { metric: 'rank', value: 'not-a-number' },
        { params: { projectId: p.id, slug: 'no-such-goal' } },
      );
      bad.status(400);

      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/goals/:slug/observations',
        { metric: 'rank', value: 3 },
        { params: { projectId: p.id, slug: 'no-such-goal' } },
      );
      r.status(404);
    });

    await ctx.step('read the series of an undeclared goal → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/goals/:slug/observations', {
          params: { projectId: p.id, slug: 'no-such-goal' },
        });
      r.status(404);
    });

    await ctx.step('series with a bad limit → 400 before the manifest read', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/goals/:slug/observations', {
          params: { projectId: p.id, slug: 'no-such-goal' },
          query: { limit: '0' },
        });
      r.status(400);
    });

    await ctx.step('ANON → 401 on the goal list', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/agi/goals', { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// ─── AGI-5 — liveness: "what is stuck, and why", plus the sweep ─────────────

flow(
  'AGI-5',
  {
    domain: 'agi',
    tags: ['agi', 'liveness'],
    routes: [
      'GET /v1/projects/:projectId/agi/liveness',
      'POST /v1/projects/:projectId/agi/liveness/sweep',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await enableAgi(ctx, p.id);
    const taskId = await createTask(ctx, p.id, { title: 'Open work', status: 'todo' });

    await ctx.step('read → 200 with both halves of the surface', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/liveness', { params: { projectId: p.id } });
      r.status(200)
        .body()
        .exists('$.tasks')
        .exists('$.stalled')
        .exists('$.stalled_count')
        // R-12e: the goal half. A stall surface that can only see tasks is the
        // blind spot §4.2 was written about.
        .exists('$.goals')
        .exists('$.stalled_goals')
        .exists('$.unmeasurable_goals')
        .exists('$.stalled_total');
      const ids = r.json().tasks.map((view: any) => view.task.task_id);
      if (!ids.includes(taskId)) throw new Error('open task missing from the liveness read');
    });

    await ctx.step('a bad limit → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/agi/liveness', {
        params: { projectId: p.id },
        query: { limit: 'lots' },
      });
      r.status(400);
    });

    // The sweep is explicit, on-demand and idempotent (R-21/R-32) — not a
    // poller. Calling it twice with unchanged evidence must change nothing the
    // first call did not already do.
    await ctx.step('sweep → 200, and a second sweep reports the same shape', async () => {
      const first = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/agi/liveness/sweep', {}, { params: { projectId: p.id } });
      first.status(200).body().exists('$.scanned').exists('$.stalled').exists('$.outcomes');

      const second = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:projectId/agi/liveness/sweep', {}, { params: { projectId: p.id } });
      second.status(200).body().has('$.scanned', first.json().scanned);
    });

    await ctx.step('ANON → 401 on the sweep', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/projects/:projectId/agi/liveness/sweep', {}, { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// ─── AGI-6 — requests: reaching a human when nobody is watching (§4.3) ──────

flow(
  'AGI-6',
  {
    domain: 'agi',
    tags: ['agi', 'requests'],
    routes: [
      'POST /v1/projects/:projectId/agi/tasks/:taskId/requests',
      'GET /v1/projects/:projectId/agi/requests',
      'POST /v1/projects/:projectId/agi/requests/:requestId',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await enableAgi(ctx, p.id);
    const taskId = await createTask(ctx, p.id, { title: 'Blocked on a credential' });

    let requestId = '';

    await ctx.step('raise a request → 201, delivered to a real human', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/requests',
        { kind: 'secret', need: 'STRIPE_API_KEY', why: 'The push cannot bill without it.' },
        { params: { projectId: p.id, taskId } },
      );
      r.status(201).body().has('$.created', true).exists('$.request.responder_user_id');
      requestId = r.json().request.request_id;
    });

    // A dedupe is deliberately NOT re-delivered: the human was already told, and
    // the fix for an ignored ask is a louder inbox, never a daily repeat.
    await ctx.step('the same ask again → 200 created:false', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/requests',
        { kind: 'secret', need: 'STRIPE_API_KEY' },
        { params: { projectId: p.id, taskId } },
      );
      r.status(200).body().has('$.created', false);
    });

    await ctx.step('a bad kind or an empty need → 400', async () => {
      for (const body of [
        { kind: 'vibes', need: 'x' },
        { kind: 'secret', need: '   ' },
        { kind: 'secret', need: 'x', responder_user_id: UNKNOWN_UUID },
      ]) {
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/projects/:projectId/agi/tasks/:taskId/requests',
          body,
          { params: { projectId: p.id, taskId } },
        );
        r.status(400);
      }
    });

    await ctx.step('raise against an unknown task → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/tasks/:taskId/requests',
        { kind: 'access', need: 'repo admin' },
        { params: { projectId: p.id, taskId: UNKNOWN_UUID } },
      );
      r.status(404);
    });

    // `responder=me` is resolved server-side: a client that had to know its own
    // user id to ask "what is waiting on me?" would get it wrong inside an
    // unattended run, which is exactly when it matters.
    await ctx.step('inbox → 200, and ?responder=me resolves server-side', async () => {
      const all = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/requests', { params: { projectId: p.id } });
      all.status(200).body().exists('$.requests');
      const ids = all.json().requests.map((row: any) => row.request_id);
      if (!ids.includes(requestId)) throw new Error('raised request missing from the inbox');

      const mine = await ctx.client.as(ctx.P.OWNER).get('/v1/projects/:projectId/agi/requests', {
        params: { projectId: p.id },
        query: { responder: 'me' },
      });
      mine.status(200).body().exists('$.requests');

      const undelivered = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/agi/requests', {
          params: { projectId: p.id },
          query: { undelivered: '1' },
        });
      undelivered.status(200).body().exists('$.requests');
    });

    await ctx.step('bad inbox filters → 400', async () => {
      for (const query of [
        { status: 'not-a-status' },
        { responder: 'someone' },
        { task: 'not-a-uuid' },
        { undelivered: 'sure' },
        { limit: '0' },
      ]) {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId/agi/requests', { params: { projectId: p.id }, query });
        r.status(400);
      }
    });

    await ctx.step('close it → 200 satisfied', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/requests/:requestId',
        { status: 'satisfied', note: 'Supplied through the minted link.' },
        { params: { projectId: p.id, requestId } },
      );
      r.status(200).body().has('$.request.status', 'satisfied');
    });

    // A closed request answered twice is normal; a missing one is a caller bug.
    // The two must stay distinguishable.
    await ctx.step('closing it again → 409, closing an unknown one → 404', async () => {
      const again = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/requests/:requestId',
        { status: 'satisfied' },
        { params: { projectId: p.id, requestId } },
      );
      again.status(409).body().has('$.code', 'request_not_pending');

      const unknown = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/requests/:requestId',
        { status: 'satisfied' },
        { params: { projectId: p.id, requestId: UNKNOWN_UUID } },
      );
      unknown.status(404);
    });

    await ctx.step('an unknown resolve status → 400', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/projects/:projectId/agi/requests/:requestId',
        { status: 'maybe' },
        { params: { projectId: p.id, requestId } },
      );
      r.status(400);
    });
  },
);

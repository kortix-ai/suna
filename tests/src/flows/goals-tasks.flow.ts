/**
 * Auth-bound route coverage for the durable goal/task control plane.
 *
 * These checks avoid managed Git and sandbox provisioning. The full stateful
 * contracts remain in tests/spec/end-to-end.md for a live managed-project run.
 */
import { flow } from '../core/flow';

const UNKNOWN_PROJECT = '00000000-0000-4000-a000-000000000000';
const UNKNOWN_TASK = '00000000-0000-4000-a000-000000000001';

flow(
  'GOAL-1',
  {
    domain: 'goals-tasks',
    routes: [
      'GET /v1/projects/:projectId/goals',
      'GET /v1/projects/:projectId/goals/:slug',
      'POST /v1/projects/:projectId/goals/:slug/push',
      'POST /v1/projects/:projectId/goals/:slug/observations',
      'GET /v1/projects/:projectId/goals/:slug/observations',
      'GET /v1/projects/:projectId/goals/:slug/health',
    ],
  },
  async (ctx) => {
    const params = { projectId: UNKNOWN_PROJECT, slug: 'missing-goal' };
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('anonymous callers cannot read or mutate goals', async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      (await anon.get('/v1/projects/:projectId/goals', { params })).status(401);
      (await anon.get('/v1/projects/:projectId/goals/:slug', { params })).status(401);
      (await anon.get('/v1/projects/:projectId/goals/:slug/health', { params })).status(401);
      (await anon.post('/v1/projects/:projectId/goals/:slug/push', {}, { params })).status(401);
      (
        await anon.post(
          '/v1/projects/:projectId/goals/:slug/observations',
          { metric: 'latency_ms', value: 1, source: 'ke2e' },
          { params },
        )
      ).status(401);
      (
        await anon.get('/v1/projects/:projectId/goals/:slug/observations', {
          params,
          query: { metric: 'latency_ms' },
        })
      ).status(401);
    });

    await ctx.step('authenticated callers cannot use an unknown project as an oracle', async () => {
      (await owner.get('/v1/projects/:projectId/goals', { params })).status(404);
      (await owner.get('/v1/projects/:projectId/goals/:slug', { params })).status(404);
      (await owner.get('/v1/projects/:projectId/goals/:slug/health', { params })).status(404);
      (await owner.post('/v1/projects/:projectId/goals/:slug/push', {}, { params })).status(404);
      (
        await owner.post(
          '/v1/projects/:projectId/goals/:slug/observations',
          { metric: 'latency_ms', value: 1, source: 'ke2e' },
          { params },
        )
      ).status(404);
      (
        await owner.get('/v1/projects/:projectId/goals/:slug/observations', {
          params,
          query: { metric: 'latency_ms' },
        })
      ).status(404);
    });
  },
);

flow(
  'TASK-1',
  {
    domain: 'goals-tasks',
    routes: [
      'GET /v1/projects/:projectId/tasks',
      'POST /v1/projects/:projectId/tasks',
      'GET /v1/projects/:projectId/tasks/:taskId',
    ],
  },
  async (ctx) => {
    const params = { projectId: UNKNOWN_PROJECT, taskId: UNKNOWN_TASK };
    const body = { goal_slug: 'missing-goal', title: 'Missing task', origin: 'ke2e' };

    await ctx.step('task reads and creation require authentication', async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      (await anon.get('/v1/projects/:projectId/tasks', { params })).status(401);
      (await anon.post('/v1/projects/:projectId/tasks', body, { params })).status(401);
      (await anon.get('/v1/projects/:projectId/tasks/:taskId', { params })).status(401);
    });

    await ctx.step('task reads and creation hide an unknown project', async () => {
      const owner = ctx.client.as(ctx.P.OWNER);
      (await owner.get('/v1/projects/:projectId/tasks', { params })).status(404);
      (await owner.post('/v1/projects/:projectId/tasks', body, { params })).status(404);
      (await owner.get('/v1/projects/:projectId/tasks/:taskId', { params })).status(404);
    });
  },
);

flow(
  'TASK-2',
  {
    domain: 'goals-tasks',
    routes: [
      'POST /v1/projects/:projectId/tasks/:taskId/claim',
      'POST /v1/projects/:projectId/tasks/:taskId/done',
      'POST /v1/projects/:projectId/tasks/:taskId/block',
    ],
  },
  async (ctx) => {
    const params = { projectId: UNKNOWN_PROJECT, taskId: UNKNOWN_TASK };
    const claim = { session_id: 'ke2e-session' };
    const done = { session_id: 'ke2e-session', evidence: [{ ref: 'ke2e:evidence' }] };
    const block = { session_id: 'ke2e-session', blocker: 'ke2e blocker' };

    await ctx.step('task transitions require authentication', async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      (await anon.post('/v1/projects/:projectId/tasks/:taskId/claim', claim, { params })).status(
        401,
      );
      (await anon.post('/v1/projects/:projectId/tasks/:taskId/done', done, { params })).status(401);
      (await anon.post('/v1/projects/:projectId/tasks/:taskId/block', block, { params })).status(
        401,
      );
    });

    await ctx.step('task transitions hide an unknown project', async () => {
      const owner = ctx.client.as(ctx.P.OWNER);
      (await owner.post('/v1/projects/:projectId/tasks/:taskId/claim', claim, { params })).status(
        404,
      );
      (await owner.post('/v1/projects/:projectId/tasks/:taskId/done', done, { params })).status(
        404,
      );
      (await owner.post('/v1/projects/:projectId/tasks/:taskId/block', block, { params })).status(
        404,
      );
    });
  },
);

flow(
  'TASK-3',
  {
    domain: 'goals-tasks',
    routes: [
      'POST /v1/projects/:projectId/tasks/:taskId/worker',
      'POST /v1/projects/:projectId/tasks/:taskId/progress',
      'POST /v1/projects/:projectId/tasks/:taskId/no-progress',
    ],
  },
  async (ctx) => {
    const params = { projectId: UNKNOWN_PROJECT, taskId: UNKNOWN_TASK };
    const worker = {
      session_id: 'coordinator-session',
      worker_session_id: 'worker-session',
      prompt: 'Execute the bounded task.',
      contract: { max_wall_seconds: 900, max_tokens: 50_000, max_cost_usd: 2.5, max_iterations: 8 },
    };
    const progress = {
      session_id: 'coordinator-session',
      worker_session_id: 'worker-session',
      settlement_id: 'turn-progress-1',
      ref: 'commit:abc123',
    };
    const noProgress = {
      session_id: 'coordinator-session',
      worker_session_id: 'worker-session',
      settlement_id: 'turn-1',
      reason: 'No terminal evidence',
    };
    await ctx.step('task liveness mutations require authentication', async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      (await anon.post('/v1/projects/:projectId/tasks/:taskId/worker', worker, { params })).status(
        401,
      );
      (
        await anon.post('/v1/projects/:projectId/tasks/:taskId/progress', progress, { params })
      ).status(401);
      (
        await anon.post('/v1/projects/:projectId/tasks/:taskId/no-progress', noProgress, { params })
      ).status(401);
    });
    await ctx.step('task liveness mutations hide an unknown project', async () => {
      const owner = ctx.client.as(ctx.P.OWNER);
      (await owner.post('/v1/projects/:projectId/tasks/:taskId/worker', worker, { params })).status(
        404,
      );
      (
        await owner.post('/v1/projects/:projectId/tasks/:taskId/progress', progress, { params })
      ).status(404);
      (
        await owner.post('/v1/projects/:projectId/tasks/:taskId/no-progress', noProgress, {
          params,
        })
      ).status(404);
    });
  },
);

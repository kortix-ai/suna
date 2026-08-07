import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  getProjectGoal,
  getProjectGoalHealth,
  listProjectGoalObservations,
  listProjectGoals,
  pushProjectGoal,
  recordProjectGoalObservation,
} from './goals';

let calls: Array<{ url: string; method: string; body?: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
    });
    return new Response(
      JSON.stringify({ goals: [], errors: [], observations: [], status: 'queued' }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
const last = () => calls[calls.length - 1];

test('goal reads bind and encode project and goal identifiers', async () => {
  await listProjectGoals('project/one');
  expect(last().url).toBe('http://test.local/projects/project%2Fone/goals');

  await getProjectGoal('project/one', 'ship kernel');
  expect(last().url).toBe('http://test.local/projects/project%2Fone/goals/ship%20kernel');
});

test('goal health uses the authenticated goal endpoint', async () => {
  await getProjectGoalHealth('project-1', 'ship-kernel');
  expect(last().url).toBe('http://test.local/projects/project-1/goals/ship-kernel/health');
});

test('goal push uses the explicit goal endpoint', async () => {
  await pushProjectGoal('project-1', 'ship-kernel');
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/goals/ship-kernel/push',
    method: 'POST',
    body: {},
  });
});

test('goal observation writes evidence and builds a bounded range query', async () => {
  await recordProjectGoalObservation('project-1', 'ship-kernel', {
    evaluation_id: '11111111-1111-4111-8111-111111111111',
    metric: 'passing_flows',
    value: 14,
    source: 'ke2e run 123',
    session_id: 'session-1',
    observed_at: '2026-08-06T20:00:00.000Z',
  });
  expect(last()).toMatchObject({
    url: 'http://test.local/projects/project-1/goals/ship-kernel/observations',
    method: 'POST',
    body: {
      evaluation_id: '11111111-1111-4111-8111-111111111111',
      metric: 'passing_flows',
      value: 14,
      source: 'ke2e run 123',
      session_id: 'session-1',
      observed_at: '2026-08-06T20:00:00.000Z',
    },
  });

  await listProjectGoalObservations('project-1', 'ship-kernel', {
    metric: 'passing_flows',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-07T00:00:00.000Z',
    limit: 20,
  });
  expect(last().url).toBe(
    'http://test.local/projects/project-1/goals/ship-kernel/observations?metric=passing_flows&from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-07T00%3A00%3A00.000Z&limit=20',
  );
});

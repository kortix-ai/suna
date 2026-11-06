/**
 * The goal control seam every host uses: a write lands in the cache as the
 * server answered it, a stale write (`409 goal_conflict`) lands the current
 * goal, and a double submit sends one request.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import { configureKortix } from '../core/http/config';
import { WorkspaceGoalConflictError, type ProjectGoal, type ProjectGoalRecord } from '../core/rest/projects-client';
import { qk } from './query-keys';
import { runWorkspaceGoalControl } from './use-goals';

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const RECORD = {
  goal_id: 'g1', project_id: 'p1', revision: 4, title: 'Close', state: 'active', waiting_on: null, chase_at: null, summary: '',
  paused_at: null, paused_by_user_id: null, stopped_at: null, blocked_reason: null, assigned_user_id: 'u1', created_by_user_id: 'u1',
  agent: 'a', space: null, drive_id: 'd1', folder: '/Users/u1/Goals/close', box_folder: '/drives/me/Goals/close', slug: 'close',
  owner_session_id: 's1', sessions: [], criteria_revision: 1, criteria: [], verification: null, heartbeat_every: '4h',
  next_wake_at: null, last_wake_at: null, max_wakes_per_day: 12, wakes_today: 0, max_sessions: 10, provenance: 'api',
  created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z',
  capabilities: { read: true, edit: true, pause: true, resume: false, stop: true, restart: false, answer: true, edit_criteria: true },
} satisfies ProjectGoalRecord;

let calls: string[] = [];
let respond: (path: string) => Response;

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (input: unknown) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    // A real round trip: the second call arrives while the first is in flight.
    await new Promise((r) => setTimeout(r, 5));
    return respond(url.pathname);
  }) as unknown as typeof fetch;
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const seed = (qc: QueryClient, goal: ProjectGoalRecord) => {
  qc.setQueryData(qk.project.goals('p1'), [{ goalId: goal.goal_id, revision: goal.revision, record: goal } as unknown as ProjectGoal]);
};

describe('runProjectGoalControl', () => {
  test('a pause writes the goal the server returned into the list and the goal entry', async () => {
    respond = () => json(200, { goal: { ...RECORD, revision: 5, paused_at: '2026-10-21T11:00:00Z' } });
    const qc = new QueryClient();
    seed(qc, RECORD);
    const goal = { goalId: 'g1', revision: 4 } as ProjectGoal;
    const next = await runWorkspaceGoalControl(qc, 'p1', { goal, action: 'pause', reason: 'x' });
    expect(calls).toEqual(['/workspaces/p1/goals/g1/pause']);
    expect(next?.revision).toBe(5);
    expect(qc.getQueryData<ProjectGoal>(qk.project.goal('p1', 'g1'))?.revision).toBe(5);
    expect(qc.getQueryData<ProjectGoal[]>(qk.project.goals('p1'))?.[0]?.revision).toBe(5);
  });

  test('a double submit of the same control on the same goal sends one request', async () => {
    respond = () => json(200, { goal: { ...RECORD, revision: 5 } });
    const qc = new QueryClient();
    const goal = { goalId: 'g1', revision: 4 } as ProjectGoal;
    const [a, b] = await Promise.all([
      runWorkspaceGoalControl(qc, 'p1', { goal, action: 'stop', reason: 'x' }),
      runWorkspaceGoalControl(qc, 'p1', { goal, action: 'stop', reason: 'x' }),
    ]);
    expect(calls).toEqual(['/workspaces/p1/goals/g1/stop']);
    expect(a).toBe(b);
  });

  test('a 409 goal_conflict stores the current goal and rethrows the typed error', async () => {
    respond = () => json(409, { error: 'goal_conflict', message: 'The goal changed.', goal: { ...RECORD, revision: 9, state: 'stopped' } });
    const qc = new QueryClient();
    seed(qc, RECORD);
    const error = await runWorkspaceGoalControl(qc, 'p1', { goal: { goalId: 'g1', revision: 4 } as ProjectGoal, action: 'resume' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceGoalConflictError);
    expect(qc.getQueryData<ProjectGoal>(qk.project.goal('p1', 'g1'))?.revision).toBe(9);
    expect(qc.getQueryData<ProjectGoal[]>(qk.project.goals('p1'))?.[0]?.record.state).toBe('stopped');
  });

  test('an answer posts once per answer id and then re-reads the goal', async () => {
    respond = (path) => (path.endsWith('/answer') ? json(200, { goal: { ...RECORD, revision: 6 } }) : json(200, { goal: RECORD }));
    const qc = new QueryClient();
    const goal = { goalId: 'g1', revision: 4 } as ProjectGoal;
    await Promise.all([
      runWorkspaceGoalControl(qc, 'p1', { goal, action: 'answer', text: 'yes', answerId: 'a-1' }),
      runWorkspaceGoalControl(qc, 'p1', { goal, action: 'answer', text: 'yes', answerId: 'a-1' }),
    ]);
    expect(calls).toEqual(['/workspaces/p1/goals/g1/answer']);
  });
});

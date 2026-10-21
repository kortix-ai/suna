import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getProjectGoalFiles, goalHealth, listProjectGoals, type ProjectGoalDocument } from './goals';
import type { ProjectReminder } from './session-reminders';

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

const GOAL: ProjectGoalDocument = {
  version: 1,
  objective: 'Old bank account fully closed',
  status: 'waiting_on_user',
  summary: 'Closure requested; waiting for the 2FA approval.',
  success_criteria: [
    { id: 'c1', text: 'Written closure confirmation', met: true, evidence: 'evidence/closure.pdf' },
    { id: 'c2', text: 'No charges for 30 days', met: false, evidence: null },
  ],
  items: [
    { id: 'i1', kind: 'task', title: 'Request closure', status: 'done', owner: 'agent', due: null },
    { id: 'i2', kind: 'ask', title: 'Approve the 2FA prompt', status: 'open', owner: 'user', due: '2026-10-22T09:00:00Z' },
  ],
  sessions: [{ id: 's-coord', role: 'coordinator', since: '2026-10-20T10:00:00Z' }],
  reminder_id: 'reminder.aaaaaaaaaaaa',
  transitions: [
    { from: null, to: 'draft', at: '2026-10-20T10:00:00Z', reason: 'goal created', by: 's-coord' },
    { from: 'draft', to: 'active', at: '2026-10-20T10:05:00Z', reason: 'criteria written', by: 's-coord' },
    { from: 'active', to: 'waiting_on_user', at: '2026-10-20T11:00:00Z', reason: 'asked for 2FA', by: 's-coord' },
  ],
  verified_by: null,
  next_wake_at: '2026-10-22T10:00:00Z',
};

const HEARTBEAT: ProjectReminder = {
  id: 'reminder.aaaaaaaaaaaa',
  session_id: 's-coord',
  session_name: 'Close the bank account',
  name: 'goal bank-close',
  prompt: 'Goal wake: /drives/company/Goals/bank-close. Load the kortix-goals skill and run one wake.',
  every: '1d',
  every_seconds: 86400,
  cron: null,
  timezone: 'UTC',
  at: null,
  state: 'active',
  next_fire_at: '2026-10-22T10:00:00.000Z',
  last_fired_at: '2026-10-21T10:00:00.000Z',
  last_status: 'fired',
  last_error: null,
  created_by: 'u1',
  created_at: '2026-10-20T10:00:00.000Z',
};

describe('goalHealth', () => {
  test('an open goal with a live heartbeat is healthy', () => {
    expect(goalHealth(GOAL, HEARTBEAT, NOW)).toEqual({ state: 'healthy', issues: [] });
  });

  test('a closed goal is closed, whatever its heartbeat', () => {
    expect(goalHealth({ ...GOAL, status: 'done' }, null, NOW)).toEqual({ state: 'closed', issues: [] });
    expect(goalHealth({ ...GOAL, status: 'abandoned' }, HEARTBEAT, NOW)).toEqual({ state: 'closed', issues: [] });
  });

  test('an open goal with nothing to wake it needs attention', () => {
    expect(goalHealth(GOAL, null, NOW)).toEqual({ state: 'attention', issues: ['no_heartbeat'] });
    expect(goalHealth(GOAL, { ...HEARTBEAT, state: 'paused' }, NOW).issues).toEqual(['heartbeat_paused']);
    expect(goalHealth(GOAL, { ...HEARTBEAT, state: 'done' }, NOW).issues).toEqual(['no_heartbeat']);
  });

  test('a failed last wake and a wake more than 15 minutes late both need attention', () => {
    expect(goalHealth(GOAL, { ...HEARTBEAT, last_status: 'failed', last_error: 'Session create failed' }, NOW).issues).toEqual([
      'heartbeat_failed',
    ]);
    expect(goalHealth(GOAL, { ...HEARTBEAT, next_fire_at: '2026-10-21T11:40:00.000Z' }, NOW).issues).toEqual(['missed_wake']);
    expect(goalHealth(GOAL, { ...HEARTBEAT, next_fire_at: '2026-10-21T11:50:00.000Z' }, NOW).issues).toEqual([]);
  });

  test('an open ask past its due time needs attention', () => {
    const overdue = { ...GOAL, items: [{ ...GOAL.items[1]!, due: '2026-10-21T09:00:00Z' }] };
    expect(goalHealth(overdue, HEARTBEAT, NOW).issues).toEqual(['ask_overdue']);
  });

  test('verification that has not finished within 24 hours needs attention', () => {
    const verifying = {
      ...GOAL,
      status: 'verifying' as const,
      transitions: [...GOAL.transitions, { from: 'active' as const, to: 'verifying' as const, at: '2026-10-20T09:00:00Z', reason: 'all met', by: 's-coord' }],
    };
    expect(goalHealth(verifying, HEARTBEAT, NOW).issues).toEqual(['verification_stalled']);
  });

  test('an unreadable goal.json needs attention', () => {
    expect(goalHealth(null, HEARTBEAT, NOW)).toEqual({ state: 'attention', issues: ['unreadable'] });
  });
});

describe('listProjectGoals', () => {
  let requested: string[] = [];
  const routes: Record<string, { status: number; body: unknown }> = {};

  beforeEach(() => {
    requested = [];
    for (const key of Object.keys(routes)) delete routes[key];
    globalThis.fetch = mock(async (input: unknown) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const key = `${url.pathname}${url.searchParams.has('path') ? `?path=${url.searchParams.get('path')}` : ''}`;
      requested.push(key);
      const route = routes[key] ?? { status: 404, body: { message: 'Not found' } };
      const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return new Response(body, { status: route.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  });

  const drive = { driveId: 'd1', projectId: 'p1', personalFolder: '/Users/ana' };
  const dir = (path: string) => ({ path, name: path.split('/').at(-1), type: 'dir', size: 0, mtime: 0, access: 'write' });

  test('reads every goal folder in Company and the caller\'s own folder, with its heartbeat and health', async () => {
    routes['/drives'] = { status: 200, body: { drives: [drive] } };
    routes['/drives/d1/files?path=/Company/Goals'] = { status: 200, body: { entries: [dir('/Company/Goals/bank-close')], access: 'write' } };
    routes['/drives/d1/files?path=/Users/ana/Goals'] = {
      status: 200,
      body: { entries: [dir('/Users/ana/Goals/broken'), { ...dir('/Users/ana/Goals/readme.md'), type: 'file' }], access: 'write' },
    };
    routes['/drives/d1/files/content?path=/Company/Goals/bank-close/goal.json'] = { status: 200, body: GOAL };
    routes['/drives/d1/files/content?path=/Users/ana/Goals/broken/goal.json'] = { status: 200, body: '{ not json' };
    routes['/projects/p1/reminders'] = { status: 200, body: { reminders: [HEARTBEAT] } };

    const goals = await listProjectGoals('p1', { now: NOW });

    expect(goals).toHaveLength(2);
    const [company, personal] = goals;
    expect(company).toMatchObject({
      slug: 'bank-close',
      scope: 'company',
      driveId: 'd1',
      folder: '/Company/Goals/bank-close',
      coordinatorSessionId: 's-coord',
      heartbeat: { id: 'reminder.aaaaaaaaaaaa' },
      health: { state: 'healthy', issues: [] },
    });
    expect(company!.goal?.objective).toBe('Old bank account fully closed');
    expect(personal).toMatchObject({ slug: 'broken', scope: 'personal', goal: null, health: { state: 'attention', issues: ['unreadable'] } });
  });

  test('finds the heartbeat by the goal folder when goal.json lost its reminder_id', async () => {
    routes['/drives'] = { status: 200, body: { drives: [{ ...drive, personalFolder: null }] } };
    routes['/drives/d1/files?path=/Company/Goals'] = { status: 200, body: { entries: [dir('/Company/Goals/bank-close')], access: 'write' } };
    routes['/drives/d1/files/content?path=/Company/Goals/bank-close/goal.json'] = { status: 200, body: { ...GOAL, reminder_id: null } };
    routes['/projects/p1/reminders'] = { status: 200, body: { reminders: [HEARTBEAT] } };

    const [goal] = await listProjectGoals('p1', { now: NOW });
    expect(goal?.heartbeat?.id).toBe('reminder.aaaaaaaaaaaa');
    expect(requested).not.toContain('/drives/d1/files?path=null/Goals');
  });

  test('a project without Files or without Goals folders has no goals', async () => {
    routes['/drives'] = { status: 200, body: { drives: [] } };
    expect(await listProjectGoals('p1')).toEqual([]);
    routes['/drives'] = { status: 200, body: { drives: [drive] } };
    routes['/projects/p1/reminders'] = { status: 200, body: { reminders: [] } };
    expect(await listProjectGoals('p1')).toEqual([]);
  });

  test('getProjectGoalFiles reads log.md, notes.md and the verification, null when absent', async () => {
    routes['/drives/d1/files/content?path=/Company/Goals/bank-close/log.md'] = { status: 200, body: '# Log\n' };
    routes['/drives/d1/files/content?path=/Company/Goals/bank-close/notes.md'] = { status: 200, body: '# Notes\n' };
    expect(await getProjectGoalFiles('d1', '/Company/Goals/bank-close')).toEqual({
      log: '# Log\n',
      notes: '# Notes\n',
      verification: null,
    });
  });
});

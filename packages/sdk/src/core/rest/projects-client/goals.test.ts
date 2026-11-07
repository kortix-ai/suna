import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  createWorkspaceGoal,
  createWorkspaceGoalRecord,
  defaultGoalAgent,
  getWorkspaceGoal,
  getWorkspaceGoalFiles,
  goalHealth,
  listWorkspaceGoalEvents,
  listWorkspaceGoalRecords,
  listWorkspaceGoals,
  MAKE_GOAL_PROMPT,
  MAX_GOAL_CRITERIA,
  makeSessionGoal,
  pauseWorkspaceGoal,
  postWorkspaceGoalAction,
  WorkspaceGoalConflictError,
  replyToWorkspaceGoal,
  restartWorkspaceGoal,
  resumeWorkspaceGoal,
  setWorkspaceGoalBinding,
  setWorkspaceGoalCriteria,
  stopWorkspaceGoal,
  type ProjectGoalDocument,
  type ProjectGoalEvent,
  type ProjectGoalRecord,
} from './goals';
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

// ── The server goal record: `/v1/workspaces/:projectId/goals/*` ──────────────

const RECORD: ProjectGoalRecord = {
  goal_id: '7d3f8a52-1c4e-4b7a-9f2d-0a1b2c3d4e5f',
  project_id: 'p1',
  revision: 4,
  title: 'EU billing live',
  state: 'active',
  waiting_on: null,
  chase_at: null,
  summary: 'Invoices go out in EUR.',
  paused_at: null,
  paused_by_user_id: null,
  stopped_at: null,
  blocked_reason: null,
  assigned_user_id: 'u1',
  created_by_user_id: 'u1',
  agent: 'billing',
  space: null,
  drive_id: 'd1',
  folder: '/Users/u1/Goals/eu-billing-live',
  box_folder: '/drives/me/Goals/eu-billing-live',
  slug: 'eu-billing-live',
  owner_session_id: 's-owner',
  sessions: [{ id: 's-owner', role: 'owner', since: '2026-10-20T10:00:00Z' }],
  criteria_revision: 1,
  criteria: [
    { id: 'c1', text: 'Invoices in EUR', reported_met: true, evidence: 'evidence/invoice.pdf', verified: false },
    { id: 'c2', text: 'VAT on every invoice', reported_met: false, evidence: null, verified: false },
  ],
  verification: null,
  heartbeat_every: '4h',
  next_wake_at: '2026-10-21T14:00:00Z',
  last_wake_at: '2026-10-21T10:00:00Z',
  max_wakes_per_day: 12,
  wakes_today: 3,
  max_sessions: 10,
  provenance: 'api',
  created_at: '2026-10-20T10:00:00Z',
  updated_at: '2026-10-21T10:00:00Z',
  capabilities: { read: true, edit: true, pause: true, resume: false, stop: true, restart: false, answer: true, edit_criteria: true },
};

type Call = { method: string; key: string; body: unknown };

/** A fetch mock keyed `METHOD /path`; the query string is part of the path. */
function serve(routes: Record<string, { status: number; body: unknown }>, calls: Call[]) {
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}${url.search}`;
    const raw = init.body != null ? await new Response(init.body as BodyInit).text() : request ? await request.clone().text() : '';
    calls.push({ method, key, body: raw ? JSON.parse(raw) : null });
    const route = routes[key] ?? { status: 404, body: { error: 'goal_not_found', message: 'Not found' } };
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return new Response(text, { status: route.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('goal record: list, read, health', () => {
  let calls: Call[] = [];
  const routes: Record<string, { status: number; body: unknown }> = {};
  beforeEach(() => {
    calls = [];
    for (const key of Object.keys(routes)) delete routes[key];
    serve(routes, calls);
  });

  test('listProjectGoals reads GET /workspaces/:pid/goals and keeps the ProjectGoal shape', async () => {
    const company = { ...RECORD, goal_id: 'g-company', slug: 'close', folder: '/Company/Goals/close', owner_session_id: null };
    routes['GET /workspaces/p1/goals'] = { status: 200, body: { goals: [RECORD, company] } };
    const [goal, other] = await listWorkspaceGoals('p1', { now: NOW });
    expect(calls.map((c) => c.key)).toEqual(['GET /workspaces/p1/goals']);
    expect(goal).toMatchObject({
      projectId: 'p1',
      goalId: RECORD.goal_id,
      revision: 4,
      slug: 'eu-billing-live',
      scope: 'personal',
      driveId: 'd1',
      folder: '/Users/u1/Goals/eu-billing-live',
      heartbeat: null,
      coordinatorSessionId: 's-owner',
      capabilities: RECORD.capabilities,
      blockedReason: null,
      verification: null,
      criteria: RECORD.criteria,
      record: RECORD,
    });
    // The legacy document view: `met` is the owner's claim, `reported_met`.
    expect(goal!.goal).toMatchObject({
      objective: 'EU billing live',
      status: 'active',
      summary: 'Invoices go out in EUR.',
      agent: 'billing',
      assigned_user: 'u1',
      max_wakes_per_day: 12,
      wake_count: 3,
      success_criteria: [
        { id: 'c1', text: 'Invoices in EUR', met: true, evidence: 'evidence/invoice.pdf' },
        { id: 'c2', text: 'VAT on every invoice', met: false, evidence: null },
      ],
      sessions: RECORD.sessions,
    });
    expect(other).toMatchObject({ scope: 'company', coordinatorSessionId: null });
  });

  test('listProjectGoals is empty when the route is off (404, or 403 feature_disabled) and throws on any other error', async () => {
    expect(await listWorkspaceGoals('p1')).toEqual([]);
    routes['GET /workspaces/p1/goals'] = { status: 403, body: { error: 'Goals is not enabled for this project.', code: 'feature_disabled' } };
    expect(await listWorkspaceGoals('p1')).toEqual([]);
    routes['GET /workspaces/p1/goals'] = { status: 500, body: { message: 'boom' } };
    await expect(listWorkspaceGoals('p1')).rejects.toMatchObject({ status: 500 });
  });

  test('getProjectGoal reads one goal by goal_id; a missing one is an ApiError 404', async () => {
    routes[`GET /workspaces/p1/goals/${RECORD.goal_id}`] = { status: 200, body: { goal: RECORD } };
    expect(await getWorkspaceGoal('p1', RECORD.goal_id)).toMatchObject({ goalId: RECORD.goal_id, revision: 4 });
    await expect(getWorkspaceGoal('p1', 'gone')).rejects.toMatchObject({ status: 404 });
  });

  test('listProjectGoalEvents pages through GET …/events with the cursor', async () => {
    const event: ProjectGoalEvent = { id: 'e1', goal_id: RECORD.goal_id, at: '2026-10-20T10:00:00Z', kind: 'created', actor_kind: 'user', actor_id: 'u1', from_state: null, to_state: 'draft', message: 'Goal created', data: {} };
    routes[`GET /workspaces/p1/goals/${RECORD.goal_id}/events`] = { status: 200, body: { events: [event], next_cursor: 'c2' } };
    routes[`GET /workspaces/p1/goals/${RECORD.goal_id}/events?cursor=c2`] = { status: 200, body: { events: [], next_cursor: null } };
    expect(await listWorkspaceGoalEvents('p1', RECORD.goal_id)).toEqual({ events: [event], nextCursor: 'c2' });
    expect(await listWorkspaceGoalEvents('p1', RECORD.goal_id, { cursor: 'c2' })).toEqual({ events: [], nextCursor: null });
  });

  test('goalHealth reads a record by its server fields', () => {
    expect(goalHealth(RECORD, null, NOW)).toEqual({ state: 'healthy', issues: [] });
    expect(goalHealth({ ...RECORD, state: 'done' }, null, NOW)).toEqual({ state: 'closed', issues: [] });
    expect(goalHealth({ ...RECORD, state: 'stopped' }, null, NOW).state).toBe('closed');
    // A pause is the server's: nothing is due.
    expect(goalHealth({ ...RECORD, paused_at: '2026-10-21T11:00:00Z', next_wake_at: null }, null, NOW)).toEqual({ state: 'healthy', issues: [] });
    // Blocked: the reason explains it; no wake check on top.
    expect(goalHealth({ ...RECORD, blocked_reason: 'credits', next_wake_at: '2026-10-21T09:00:00Z' }, null, NOW)).toEqual({ state: 'attention', issues: ['blocked'] });
    expect(goalHealth({ ...RECORD, next_wake_at: '2026-10-21T11:40:00Z' }, null, NOW).issues).toEqual(['missed_wake']);
    expect(goalHealth({ ...RECORD, next_wake_at: '2026-10-21T11:50:00Z' }, null, NOW).issues).toEqual([]);
    expect(goalHealth({ ...RECORD, next_wake_at: null }, null, NOW).issues).toEqual(['no_heartbeat']);
    // Waiting costs no wake: no next wake is expected unless it asked to chase.
    expect(goalHealth({ ...RECORD, state: 'waiting_on_user', next_wake_at: null }, null, NOW).issues).toEqual([]);
    expect(goalHealth({ ...RECORD, state: 'waiting_on_user', chase_at: '2026-10-21T09:00:00Z', next_wake_at: '2026-10-21T09:00:00Z' }, null, NOW).issues).toEqual(['missed_wake']);
    const verification = { attempt: 1, verifier_session_id: 's-v', criteria_revision: 1, started_at: '2026-10-20T09:00:00Z', decided_at: null, outcome: 'pending' as const, results: [], evidence_hashes: {} };
    expect(goalHealth({ ...RECORD, state: 'verifying', next_wake_at: null, verification }, null, NOW).issues).toEqual(['verification_stalled']);
    expect(goalHealth({ ...RECORD, state: 'verifying', next_wake_at: null, verification: { ...verification, started_at: '2026-10-21T09:00:00Z' } }, null, NOW).issues).toEqual([]);
  });

  test('getProjectGoalFiles also reads the GOAL.md brief', async () => {
    serve({}, calls);
    globalThis.fetch = mock(async (input: unknown) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.searchParams.get('path');
      const files: Record<string, string> = { '/Company/Goals/close/GOAL.md': '# Close\n', '/Company/Goals/close/log.md': '# Log\n' };
      return path && files[path] ? new Response(files[path], { status: 200 }) : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await getWorkspaceGoalFiles('d1', '/Company/Goals/close')).toEqual({ brief: '# Close\n', log: '# Log\n', notes: null, verification: null });
  });
});

describe('goal record: a person creates and controls a goal', () => {
  let calls: Call[] = [];
  const routes: Record<string, { status: number; body: unknown }> = {};
  const base = `/workspaces/p1/goals/${RECORD.goal_id}`;
  beforeEach(() => {
    calls = [];
    for (const key of Object.keys(routes)) delete routes[key];
    serve(routes, calls);
  });

  test('createProjectGoal POSTs the brief with goal_id as the idempotency key; a retry with the same id sends the same id', async () => {
    routes['POST /workspaces/p1/goals'] = { status: 201, body: { goal: { ...RECORD, state: 'draft' } } };
    const input = { outcome: '  EU billing live\n- EUR\nall of it  ', criteria: ['Invoices in EUR', ' ', 'VAT on every invoice'], agent: 'billing', assignedUser: 'u1', goalId: RECORD.goal_id };
    const created = await createWorkspaceGoal('p1', input);
    await createWorkspaceGoal('p1', input);
    expect(calls.map((c) => c.key)).toEqual(['POST /workspaces/p1/goals', 'POST /workspaces/p1/goals']);
    expect(calls[0]!.body).toEqual({
      goal_id: RECORD.goal_id,
      // A plain line after a list item gets a blank line, so Markdown does not fold it into the item.
      brief: 'EU billing live\n- EUR\n\nall of it',
      criteria: ['Invoices in EUR', 'VAT on every invoice'],
      agent: 'billing',
      assigned_user_id: 'u1',
    });
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(created).toMatchObject({
      goalId: RECORD.goal_id,
      slug: 'eu-billing-live',
      scope: 'personal',
      driveId: 'd1',
      folder: RECORD.folder,
      sessionId: 's-owner',
      goal: { goalId: RECORD.goal_id, revision: 4 },
    });
  });

  test('createProjectGoal maps the deprecated sessionId to goal_id, and generates one when neither is given', async () => {
    routes['POST /workspaces/p1/goals'] = { status: 201, body: { goal: RECORD } };
    await createWorkspaceGoal('p1', { outcome: 'A', sessionId: '0b6c7c55-8f3e-4b8a-9d55-0e0f6a1c2d3e' });
    await createWorkspaceGoal('p1', { outcome: 'B' });
    expect((calls[0]!.body as { goal_id: string }).goal_id).toBe('0b6c7c55-8f3e-4b8a-9d55-0e0f6a1c2d3e');
    const generated = (calls[1]!.body as { goal_id: string }).goal_id;
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // No criteria, no agent, no person: the keys are absent, the server decides.
    expect(calls[1]!.body).toEqual({ goal_id: generated, brief: 'B' });
  });

  test('createProjectGoal refuses an empty outcome and more than 8 criteria before any request', async () => {
    await expect(createWorkspaceGoal('p1', { outcome: '   ' })).rejects.toThrow('Describe the outcome.');
    await expect(createWorkspaceGoal('p1', { outcome: 'x', criteria: Array.from({ length: 9 }, (_, i) => `c${i}`) })).rejects.toThrow('at most 8');
    expect(calls).toEqual([]);
  });

  test('pause, resume, stop and restart POST the control route with the revision the caller read', async () => {
    const next = { ...RECORD, revision: 5 };
    for (const action of ['pause', 'resume', 'stop', 'restart']) routes[`POST ${base}/${action}`] = { status: 200, body: { goal: next } };
    const [goal] = await (async () => {
      routes['GET /workspaces/p1/goals'] = { status: 200, body: { goals: [RECORD] } };
      return listWorkspaceGoals('p1', { now: NOW });
    })();
    const paused = await pauseWorkspaceGoal('p1', goal!, 'Paused from the goal page.');
    await resumeWorkspaceGoal('p1', goal!);
    await stopWorkspaceGoal('p1', goal!, 'Stopped.');
    await restartWorkspaceGoal('p1', goal!, 'Again.');
    expect(calls.slice(1).map((c) => [c.key, c.body])).toEqual([
      [`POST ${base}/pause`, { revision: 4, reason: 'Paused from the goal page.' }],
      [`POST ${base}/resume`, { revision: 4 }],
      [`POST ${base}/stop`, { revision: 4, reason: 'Stopped.' }],
      [`POST ${base}/restart`, { revision: 4, reason: 'Again.' }],
    ]);
    // The document as before, plus the goal as the server now holds it.
    expect(paused).toMatchObject({ objective: 'EU billing live', status: 'active', projectGoal: { revision: 5 } });
  });

  test('a stale revision surfaces as a ProjectGoalConflictError carrying the current goal', async () => {
    const current = { ...RECORD, revision: 7, paused_at: '2026-10-21T11:00:00Z' };
    routes[`POST ${base}/pause`] = { status: 409, body: { error: 'goal_conflict', message: 'The goal changed.', goal: current } };
    const error = await pauseWorkspaceGoal('p1', { goalId: RECORD.goal_id, revision: 4 }, 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceGoalConflictError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, goal: { goalId: RECORD.goal_id, revision: 7, record: current } });
  });

  test('a 409 without a goal body stays a plain ApiError', async () => {
    routes[`POST ${base}/stop`] = { status: 409, body: { message: 'busy' } };
    const error = await stopWorkspaceGoal('p1', { goalId: RECORD.goal_id, revision: 4 }, 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(WorkspaceGoalConflictError);
  });

  test('replyToProjectGoal POSTs …/answer with an answer_id; the same answerId on a retry is sent again', async () => {
    routes[`POST ${base}/answer`] = { status: 200, body: { goal: RECORD } };
    await replyToWorkspaceGoal('p1', { goalId: RECORD.goal_id }, 'DE123456789', { answerId: 'a0b1c2d3-e4f5-4a6b-8c7d-8e9f0a1b2c3d' });
    await replyToWorkspaceGoal('p1', { goalId: RECORD.goal_id }, 'DE123456789', { answerId: 'a0b1c2d3-e4f5-4a6b-8c7d-8e9f0a1b2c3d' });
    await replyToWorkspaceGoal('p1', { goalId: RECORD.goal_id }, 'other');
    expect(calls.map((c) => c.key)).toEqual([`POST ${base}/answer`, `POST ${base}/answer`, `POST ${base}/answer`]);
    expect(calls[0]!.body).toEqual({ answer_id: 'a0b1c2d3-e4f5-4a6b-8c7d-8e9f0a1b2c3d', text: 'DE123456789' });
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect((calls[2]!.body as { answer_id: string }).answer_id).not.toBe('a0b1c2d3-e4f5-4a6b-8c7d-8e9f0a1b2c3d');
  });

  test('an answer route that replies 202 with no goal body still resolves; a refusal throws', async () => {
    routes[`POST ${base}/answer`] = { status: 202, body: {} };
    await expect(replyToWorkspaceGoal('p1', { goalId: RECORD.goal_id }, 'ok')).resolves.toBeUndefined();
    routes[`POST ${base}/answer`] = { status: 422, body: { error: 'goal_invalid', message: 'The goal is paused.' } };
    await expect(replyToWorkspaceGoal('p1', { goalId: RECORD.goal_id }, 'ok')).rejects.toMatchObject({ status: 422 });
  });

  test('setProjectGoalBinding PATCHes the goal record (not goal.json): null clears, an absent key keeps', async () => {
    routes[`PATCH ${base}`] = { status: 200, body: { goal: { ...RECORD, revision: 5, space: 'finance', agent: null } } };
    const doc = await setWorkspaceGoalBinding({ projectId: 'p1', goalId: RECORD.goal_id, revision: 4 }, { space: 'finance', agent: null });
    expect(calls.map((c) => [c.key, c.body])).toEqual([[`PATCH ${base}`, { revision: 4, space: 'finance', agent: null }]]);
    expect(doc).toMatchObject({ space: 'finance', agent: null, projectGoal: { revision: 5 } });
    await setWorkspaceGoalBinding({ projectId: 'p1', goalId: RECORD.goal_id, revision: 5 }, { space: 'ops' });
    expect(calls[1]!.body).toEqual({ revision: 5, space: 'ops' });
  });

  test('makeSessionGoal asks that chat session to make a goal through the kortix-goals skill', async () => {
    routes['POST /workspaces/p1/sessions/s-chat/prompts'] = { status: 202, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false } };
    await makeSessionGoal('p1', 's-chat');
    expect(calls[0]!.key).toBe('POST /workspaces/p1/sessions/s-chat/prompts');
    expect((calls[0]!.body as { parts: Array<{ text: string }> }).parts[0]!.text).toBe(MAKE_GOAL_PROMPT);
  });
});

describe('defaultGoalAgent', () => {
  const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: null, mode: 'primary', ...extra });

  test('the project default, when it can work a goal', () => {
    expect(defaultGoalAgent({ default_agent: 'sales', agents: [agent('kortix'), agent('sales')] })).toBe('sales');
  });

  test('skips agents without Files (My Kortix), hidden, disabled and platform agents', () => {
    const agents = [
      agent('mykortix'),
      agent('quiet', { hidden: true }),
      agent('off', { enabled: false }),
      agent('suna', { platform: true }),
      agent('meta-box', { sandbox: 'meta' }),
      agent('worker'),
    ];
    expect(defaultGoalAgent({ default_agent: 'mykortix', agents })).toBe('worker');
  });

  test('prefers a primary agent over a subagent', () => {
    expect(defaultGoalAgent({ agents: [agent('helper', { mode: 'subagent' }), agent('lead')] })).toBe('lead');
  });

  test('null when no agent can work a goal', () => {
    expect(defaultGoalAgent({ default_agent: 'mykortix', agents: [agent('mykortix')] })).toBeNull();
    expect(defaultGoalAgent({ agents: [] })).toBeNull();
  });
});

describe('goal record: the calls a goal session makes (the CLI)', () => {
  let calls: Call[] = [];
  const routes: Record<string, { status: number; body: unknown }> = {};
  const base = `/workspaces/p1/goals/${RECORD.goal_id}`;
  beforeEach(() => {
    calls = [];
    for (const key of Object.keys(routes)) delete routes[key];
    serve(routes, calls);
  });

  test('listWorkspaceGoalRecords returns the raw records, filtered to the goals a session owns or verifies', async () => {
    routes['GET /workspaces/p1/goals'] = { status: 200, body: { goals: [RECORD] } };
    routes['GET /workspaces/p1/goals?owner_session_id=s-owner'] = { status: 200, body: { goals: [RECORD] } };
    routes['GET /workspaces/p1/goals?verifier_session_id=s%2Fv'] = { status: 200, body: { goals: [] } };
    expect(await listWorkspaceGoalRecords('p1')).toEqual([RECORD]);
    expect(await listWorkspaceGoalRecords('p1', { role: 'owner', sessionId: 's-owner' })).toEqual([RECORD]);
    expect(await listWorkspaceGoalRecords('p1', { role: 'verifier', sessionId: 's/v' })).toEqual([]);
    expect(calls.map((c) => c.key)).toEqual(['GET /workspaces/p1/goals', 'GET /workspaces/p1/goals?owner_session_id=s-owner', 'GET /workspaces/p1/goals?verifier_session_id=s%2Fv']);
  });

  test('listWorkspaceGoalRecords throws when the route is off: the caller decides (listWorkspaceGoals reads it as empty)', async () => {
    routes['GET /workspaces/p1/goals'] = { status: 403, body: { error: 'Goals is not enabled for this project.', code: 'feature_disabled' } };
    await expect(listWorkspaceGoalRecords('p1')).rejects.toMatchObject({ status: 403, code: 'feature_disabled' });
    expect(await listWorkspaceGoals('p1')).toEqual([]);
  });

  test('postWorkspaceGoalAction POSTs …/<action> with the revision first and returns the record', async () => {
    const next = { ...RECORD, revision: 5, state: 'verifying' as const };
    routes[`POST ${base}/request-verification`] = { status: 200, body: { goal: next } };
    routes[`POST ${base}/progress`] = { status: 200, body: { goal: next } };
    expect(await postWorkspaceGoalAction('p1', RECORD, 'request-verification', {})).toEqual(next);
    await postWorkspaceGoalAction('p1', RECORD, 'progress', { summary: 'Halfway.', criteria: [{ id: 'c1', reported_met: true }] });
    expect(calls.map((c) => [c.key, c.body])).toEqual([
      [`POST ${base}/request-verification`, { revision: 4 }],
      [`POST ${base}/progress`, { revision: 4, summary: 'Halfway.', criteria: [{ id: 'c1', reported_met: true }] }],
    ]);
  });

  test('a stale revision on a session write throws WorkspaceGoalConflictError whose goal.record is the current record', async () => {
    const current = { ...RECORD, revision: 9 };
    routes[`POST ${base}/handover`] = { status: 409, body: { error: 'goal_conflict', message: 'The goal changed.', goal: current } };
    routes[`PUT ${base}/criteria`] = { status: 409, body: { error: 'goal_conflict', message: 'The goal changed.', goal: current } };
    for (const write of [() => postWorkspaceGoalAction('p1', RECORD, 'handover', { note: 'n' }), () => setWorkspaceGoalCriteria('p1', RECORD, ['a'])]) {
      const error = await write().catch((e: unknown) => e);
      if (!(error instanceof WorkspaceGoalConflictError)) throw new Error(`expected a WorkspaceGoalConflictError, got ${String(error)}`);
      expect(error.goal.record).toEqual(current);
    }
  });

  test('setWorkspaceGoalCriteria PUTs …/criteria with the revision and the texts as given', async () => {
    routes[`PUT ${base}/criteria`] = { status: 200, body: { goal: { ...RECORD, revision: 5 } } };
    expect(await setWorkspaceGoalCriteria('p1', RECORD, ['Invoices in EUR', ' VAT '])).toMatchObject({ revision: 5 });
    expect(calls.map((c) => [c.key, c.body])).toEqual([[`PUT ${base}/criteria`, { revision: 4, criteria: ['Invoices in EUR', ' VAT '] }]]);
  });

  test('createWorkspaceGoalRecord POSTs the create body as given and returns the record; a 403 stays an ApiError', async () => {
    routes['POST /workspaces/p1/goals'] = { status: 201, body: { goal: { ...RECORD, state: 'draft' } } };
    const body = { goal_id: RECORD.goal_id, brief: 'EU billing live', criteria: [' Invoices in EUR '], agent: 'billing', assigned_user_id: 'u1' };
    expect(await createWorkspaceGoalRecord('p1', body)).toMatchObject({ goal_id: RECORD.goal_id, state: 'draft' });
    expect(calls.map((c) => [c.key, c.body])).toEqual([['POST /workspaces/p1/goals', body]]);
    routes['POST /workspaces/p1/goals'] = { status: 403, body: { error: 'goal_forbidden', message: 'A session cannot create a goal.' } };
    await expect(createWorkspaceGoalRecord('p1', { goal_id: RECORD.goal_id, brief: 'x' })).rejects.toMatchObject({ status: 403, details: { error: 'goal_forbidden' } });
  });

  test('a "." or ".." goal id is refused before any request: the URL parser would send it to another endpoint', async () => {
    for (const id of ['.', '..']) {
      await expect(getWorkspaceGoal('p1', id)).rejects.toThrow(`Refused the request path /workspaces/p1/goals/${id}: a "." or ".." segment`);
      await expect(postWorkspaceGoalAction('p1', { goal_id: id, revision: 1 }, 'progress', {})).rejects.toThrow(`Refused the request path /workspaces/p1/goals/${id}:`);
    }
    expect(calls).toEqual([]);
  });

  test('MAX_GOAL_CRITERIA is the API limit, 8', () => {
    expect(MAX_GOAL_CRITERIA).toBe(8);
  });
});

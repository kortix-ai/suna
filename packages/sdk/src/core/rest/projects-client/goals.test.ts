import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { formatGoalFile, parseGoalFile } from './goal-file';
import {
  createProjectGoal,
  defaultGoalAgent,
  getProjectGoalFiles,
  goalHealth,
  listProjectGoals,
  MAKE_GOAL_PROMPT,
  makeSessionGoal,
  pauseProjectGoal,
  replyToProjectGoal,
  restartProjectGoal,
  resumeProjectGoal,
  setProjectGoalBinding,
  stopProjectGoal,
  type ProjectGoalDocument,
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

  test('a goal.json with non-array lists reads as empty lists, not a crash', async () => {
    routes['/drives'] = { status: 200, body: { drives: [{ ...drive, personalFolder: null }] } };
    routes['/drives/d1/files?path=/Company/Goals'] = { status: 200, body: { entries: [dir('/Company/Goals/bank-close')], access: 'write' } };
    routes['/drives/d1/files/content?path=/Company/Goals/bank-close/goal.json'] = {
      status: 200,
      body: { ...GOAL, status: 'verifying', items: 'x', success_criteria: { a: 1 }, sessions: 7, transitions: [null, 'x'] },
    };
    routes['/projects/p1/reminders'] = { status: 200, body: { reminders: [HEARTBEAT] } };

    const [goal] = await listProjectGoals('p1', { now: NOW });
    expect(goal?.goal).toMatchObject({ items: [], success_criteria: [], sessions: [], transitions: [] });
    expect(goal?.health).toEqual({ state: 'healthy', issues: [] });
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

describe('setProjectGoalBinding', () => {
  const folder = '/Company/Goals/bank-close';
  const target = { driveId: 'd1', folder };
  let writes: Array<{ path: string | null; ifMatch: string | null; body: Record<string, unknown> }> = [];
  let putStatus = 200;

  beforeEach(() => {
    writes = [];
    putStatus = 200;
    globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if ((init.method ?? 'GET') === 'PUT') {
        const headers = new Headers(init.headers);
        const text = await new Response(init.body as BodyInit).text();
        writes.push({ path: url.searchParams.get('path'), ifMatch: headers.get('if-match'), body: JSON.parse(text) });
        const body = putStatus === 200 ? { path: url.searchParams.get('path'), size: 1, version: 'v2' } : { message: 'file_changed' };
        return new Response(JSON.stringify(body), { status: putStatus, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ...GOAL, space: 'finance' }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: 'v1' },
      });
    }) as unknown as typeof fetch;
  });

  test('merges space and agent into goal.json and writes it back on the version it read', async () => {
    const doc = await setProjectGoalBinding(target, { agent: 'builder' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: `${folder}/goal.json`, ifMatch: 'v1' });
    expect(writes[0]!.body).toMatchObject({ objective: GOAL.objective, space: 'finance', agent: 'builder' });
    expect(doc).toMatchObject({ space: 'finance', agent: 'builder' });
  });

  test('null clears a field: the goal goes back to project-wide', async () => {
    await setProjectGoalBinding(target, { space: null, agent: null });
    expect(writes[0]!.body).toMatchObject({ space: null, agent: null });
  });

  test('a concurrent write surfaces as an ApiError 409', async () => {
    putStatus = 409;
    await expect(setProjectGoalBinding(target, { space: 'ops' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('GOAL.md goals', () => {
  const OWNER_DOC: ProjectGoalDocument = {
    ...GOAL,
    status: 'waiting_on_user',
    waiting_on: 'Which VAT number do we invoice from?',
    assigned_user: 'u1',
    agent: 'billing',
    sessions: [
      { id: 's-old', role: 'owner', since: '2026-10-20T10:00:00Z' },
      { id: 's-owner', role: 'owner', since: '2026-10-21T10:00:00Z' },
    ],
    items: [],
    body: '# EU billing\n',
  };
  const heartbeat = { ...HEARTBEAT, session_id: 's-owner' };
  let requested: Array<{ method: string; key: string; body: string; ifMatch: string | null }> = [];
  const routes: Record<string, { status: number; body: unknown }> = {};

  beforeEach(() => {
    requested = [];
    for (const key of Object.keys(routes)) delete routes[key];
    globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input));
      const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
      const key = `${url.pathname}${url.searchParams.has('path') ? `?path=${url.searchParams.get('path')}` : ''}`;
      const body =
        init.body !== undefined && init.body !== null
          ? await new Response(init.body as BodyInit).text()
          : request
            ? await request.clone().text()
            : '';
      requested.push({ method, key, body, ifMatch: new Headers(init.headers ?? request?.headers).get('if-match') });
      const route = routes[`${method} ${key}`] ?? (method === 'GET' ? routes[key] : undefined) ?? { status: 404, body: { message: 'Not found' } };
      const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return new Response(text, { status: route.status, headers: { 'content-type': 'application/json', etag: 'v1' } });
    }) as unknown as typeof fetch;
  });

  const listRoutes = () => {
    routes['/drives'] = { status: 200, body: { drives: [{ driveId: 'd1', projectId: 'p1', personalFolder: null }] } };
    routes['/drives/d1/files?path=/Company/Goals'] = {
      status: 200,
      body: {
        entries: [{ path: '/Company/Goals/eu-billing', name: 'eu-billing', type: 'dir', size: 0, mtime: 0, access: 'write' }],
        access: 'write',
      },
    };
    routes['/drives/d1/files/content?path=/Company/Goals/eu-billing/GOAL.md'] = { status: 200, body: formatGoalFile(OWNER_DOC) };
    routes['/projects/p1/reminders'] = { status: 200, body: { reminders: [heartbeat] } };
  };

  test('listProjectGoals reads GOAL.md before goal.json, and the last owner is the current one', async () => {
    listRoutes();
    const [goal] = await listProjectGoals('p1', { now: NOW });
    expect(goal).toMatchObject({ slug: 'eu-billing', coordinatorSessionId: 's-owner', heartbeat: { id: HEARTBEAT.id } });
    expect(goal!.goal).toMatchObject({
      format: 'goal.md',
      waiting_on: 'Which VAT number do we invoice from?',
      assigned_user: 'u1',
      agent: 'billing',
    });
    expect(requested.some((r) => r.key.endsWith('/goal.json'))).toBe(false);
  });

  test('a stopped goal is closed', () => {
    expect(goalHealth({ ...OWNER_DOC, status: 'stopped' }, heartbeat, NOW)).toEqual({ state: 'closed', issues: [] });
  });

  test('stopProjectGoal writes state stopped on the version it read, logs it and removes the heartbeat', async () => {
    listRoutes();
    routes['PUT /drives/d1/files/content?path=/Company/Goals/eu-billing/GOAL.md'] = { status: 200, body: { version: 'v2' } };
    routes['/drives/d1/files/content?path=/Company/Goals/eu-billing/log.md'] = { status: 200, body: '# Log\n' };
    routes['PUT /drives/d1/files/content?path=/Company/Goals/eu-billing/log.md'] = { status: 200, body: { version: 'v2' } };
    routes[`DELETE /projects/p1/sessions/s-owner/reminders/${HEARTBEAT.id}`] = { status: 200, body: { ok: true } };
    const [goal] = await listProjectGoals('p1', { now: NOW });
    requested = [];

    const doc = await stopProjectGoal('p1', goal!, 'Budget moved to Q1');

    expect(doc).toMatchObject({ status: 'stopped', waiting_on: null, reminder_id: null, next_wake_at: null });
    const put = requested.find((r) => r.method === 'PUT' && r.key.endsWith('GOAL.md'))!;
    expect(put.ifMatch).toBe('v1');
    expect(parseGoalFile(put.body)?.transitions.at(-1)).toMatchObject({
      from: 'waiting_on_user',
      to: 'stopped',
      reason: 'Budget moved to Q1',
      by: 'person',
    });
    expect(requested.find((r) => r.method === 'PUT' && r.key.endsWith('log.md'))!.body).toContain(
      'waiting_on_user → stopped: Budget moved to Q1',
    );
    expect(requested.some((r) => r.method === 'DELETE' && r.key.endsWith(`/reminders/${HEARTBEAT.id}`))).toBe(true);
  });

  test('stopProjectGoal refuses a closed goal', async () => {
    listRoutes();
    routes['/drives/d1/files/content?path=/Company/Goals/eu-billing/GOAL.md'] = {
      status: 200,
      body: formatGoalFile({ ...OWNER_DOC, status: 'done' }),
    };
    const [goal] = await listProjectGoals('p1', { now: NOW });
    await expect(stopProjectGoal('p1', goal!, 'x')).rejects.toThrow('already done');
  });

  test('replyToProjectGoal queues the answer into the owner session, naming the goal folder', async () => {
    listRoutes();
    routes['POST /projects/p1/sessions/s-owner/prompts'] = {
      status: 202,
      body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false },
    };
    const [goal] = await listProjectGoals('p1', { now: NOW });
    await replyToProjectGoal('p1', goal!, 'DE123456789');
    const post = requested.find((r) => r.method === 'POST')!;
    expect(post.key).toBe('/projects/p1/sessions/s-owner/prompts');
    const text = JSON.parse(post.body).parts[0].text as string;
    expect(text).toContain('Goal reply: /drives/company/Goals/eu-billing.');
    expect(text).toContain('DE123456789');
  });

  test('makeSessionGoal asks that chat session to make a goal through the kortix-goals skill', async () => {
    routes['POST /projects/p1/sessions/s-chat/prompts'] = {
      status: 202,
      body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false },
    };
    await makeSessionGoal('p1', 's-chat');
    const post = requested.find((r) => r.method === 'POST')!;
    expect(post.key).toBe('/projects/p1/sessions/s-chat/prompts');
    expect(JSON.parse(post.body).parts[0].text).toBe(MAKE_GOAL_PROMPT);
    expect(MAKE_GOAL_PROMPT).toContain('kortix goals new');
  });
});

describe('person controls: create, pause, resume', () => {
  const SESSION = '0b6c7c55-8f3e-4b8a-9d55-0e0f6a1c2d3e';
  let requested: Array<{ method: string; key: string; body: string; ifMatch: string | null }> = [];
  const routes: Record<string, { status: number; body: unknown }> = {};

  beforeEach(() => {
    requested = [];
    for (const key of Object.keys(routes)) delete routes[key];
    globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input));
      const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
      const key = `${url.pathname}${url.searchParams.has('path') ? `?path=${url.searchParams.get('path')}` : ''}`;
      const body =
        init.body !== undefined && init.body !== null
          ? await new Response(init.body as BodyInit).text()
          : request
            ? await request.clone().text()
            : '';
      requested.push({ method, key, body, ifMatch: new Headers(init.headers ?? request?.headers).get('if-match') });
      const route = routes[`${method} ${key}`] ?? (method === 'GET' ? routes[key] : undefined) ?? { status: 404, body: { message: 'Not found' } };
      const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      return new Response(text, { status: route.status, headers: { 'content-type': 'application/json', etag: 'v1' } });
    }) as unknown as typeof fetch;
  });

  const roster = (default_agent: string | null, agents: Array<Record<string, unknown>>) =>
    (routes['/projects/p1/detail'] = { status: 200, body: { project: {}, config: { default_agent, agents }, file_count: 0, files: [] } });
  const drive = () => {
    routes['/drives'] = { status: 200, body: { drives: [{ driveId: 'd1', projectId: 'p1', personalFolder: '/Users/u1' }] } };
    roster('mykortix', [
      { name: 'mykortix', platform: true, sandbox: 'mykortix', mode: 'primary' },
      { name: 'billing', mode: 'primary' },
      { name: 'worker', mode: 'primary' },
    ]);
  };
  const put = (path: string) => (routes[`PUT /drives/d1/files/content?path=${path}`] = { status: 200, body: { version: 'v2' } });
  const sessionCreated = () => {
    routes['POST /projects/p1/sessions'] = { status: 201, body: { session_id: SESSION } };
    routes[`/projects/p1/sessions/${SESSION}/reminders`] = { status: 200, body: { reminders: [] } };
    routes[`POST /projects/p1/sessions/${SESSION}/reminders`] = {
      status: 201,
      body: { ...HEARTBEAT, id: 'reminder.bbbbbbbbbbbb', session_id: SESSION, next_fire_at: '2026-11-04T14:00:00.000Z' },
    };
    routes[`POST /projects/p1/sessions/${SESSION}/prompts`] = {
      status: 202,
      body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false },
    };
  };

  test('createProjectGoal writes a draft GOAL.md owned by the new session, then starts that session', async () => {
    drive();
    put('/Users/u1/Goals/eu-billing-live/GOAL.md');
    put('/Users/u1/Goals/eu-billing-live/log.md');
    sessionCreated();

    const created = await createProjectGoal('p1', {
      outcome: '  EU billing live  ',
      criteria: ['Invoices in EUR', ' ', 'VAT on every invoice'],
      agent: 'billing',
      assignedUser: 'u1',
      sessionId: SESSION,
      now: '2026-11-04T10:00:00.000Z',
    });

    expect(created).toEqual({
      slug: 'eu-billing-live',
      scope: 'personal',
      driveId: 'd1',
      folder: '/Users/u1/Goals/eu-billing-live',
      sessionId: SESSION,
    });
    const goalPut = requested.find((r) => r.method === 'PUT' && r.key.endsWith('GOAL.md'))!;
    const doc = parseGoalFile(goalPut.body)!;
    expect(doc).toMatchObject({
      objective: 'EU billing live',
      status: 'draft',
      assigned_user: 'u1',
      agent: 'billing',
      heartbeat_every: '4h',
      max_wakes_per_day: 12,
      max_sessions: 10,
      sessions: [{ id: SESSION, role: 'owner', since: '2026-11-04T10:00:00.000Z' }],
      transitions: [{ from: null, to: 'draft', reason: 'goal created', by: 'person' }],
    });
    expect(doc.success_criteria).toEqual([
      { id: 'c1', text: 'Invoices in EUR', met: false, evidence: null },
      { id: 'c2', text: 'VAT on every invoice', met: false, evidence: null },
    ]);
    // The session is created idle; GOAL.md is written once, with its heartbeat; only then does the first wake go in.
    const order = requested.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.key.split('?')[0].replace(`/${SESSION}`, '/:s')}`);
    expect(order).toEqual([
      'POST /projects/p1/sessions',
      'POST /projects/p1/sessions/:s/reminders',
      'PUT /drives/d1/files/content',
      'PUT /drives/d1/files/content',
      'POST /projects/p1/sessions/:s/prompts',
    ]);
    const create = JSON.parse(requested.find((r) => r.method === 'POST' && r.key === '/projects/p1/sessions')!.body);
    expect(create).toMatchObject({
      session_id: SESSION,
      name: 'EU billing live',
      agent_name: 'billing',
      metadata: { unattended: 'true', goal: '/drives/me/Goals/eu-billing-live', goal_role: 'owner' },
    });
    expect(create.initial_prompt).toBeUndefined();
    const heartbeat = JSON.parse(requested.find((r) => r.method === 'POST' && r.key.endsWith('/reminders'))!.body);
    expect(heartbeat).toMatchObject({ prompt: 'Goal wake: /drives/me/Goals/eu-billing-live. Load the kortix-goals skill and run one wake.', every: '4h', in: '4h' });
    expect(doc).toMatchObject({ reminder_id: 'reminder.bbbbbbbbbbbb', next_wake_at: '2026-11-04T14:00:00.000Z' });
    const wake = JSON.parse(requested.find((r) => r.method === 'POST' && r.key.endsWith('/prompts'))!.body);
    expect(wake.client_message_id).toBe(`goal-start:${SESSION}`);
    expect(wake.parts[0].text).toContain('Goal wake: /drives/me/Goals/eu-billing-live.');
  });

  test('createProjectGoal picks the next free slug when another goal holds the folder', async () => {
    drive();
    routes['/drives/d1/files/content?path=/Users/u1/Goals/ship-it/GOAL.md'] = {
      status: 200,
      body: formatGoalFile({ ...GOAL, sessions: [{ id: 'someone-else', role: 'owner', since: '2026-11-01T00:00:00Z' }] }),
    };
    put('/Users/u1/Goals/ship-it-2/GOAL.md');
    put('/Users/u1/Goals/ship-it-2/log.md');
    sessionCreated();
    const created = await createProjectGoal('p1', { outcome: 'Ship it', sessionId: SESSION });
    expect(created.slug).toBe('ship-it-2');
  });

  test('a retry with the same session id writes nothing twice and accepts the session that already exists', async () => {
    drive();
    routes['/drives/d1/files/content?path=/Users/u1/Goals/ship-it/GOAL.md'] = {
      status: 200,
      body: formatGoalFile({ ...GOAL, objective: 'Ship it', sessions: [{ id: SESSION, role: 'owner', since: '2026-11-01T00:00:00Z' }] }),
    };
    routes['POST /projects/p1/sessions'] = { status: 409, body: { error: 'Session already exists' } };
    routes[`POST /projects/p1/sessions/${SESSION}/prompts`] = { status: 200, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: true } };
    routes['/drives/d1/files/content?path=/Users/u1/Goals/ship-it/log.md'] = { status: 200, body: '# Log\n' };
    routes[`/projects/p1/sessions/${SESSION}/reminders`] = {
      status: 200,
      body: { reminders: [{ ...HEARTBEAT, session_id: SESSION, prompt: 'Goal wake: /drives/me/Goals/ship-it. Load the kortix-goals skill and run one wake.' }] },
    };
    const created = await createProjectGoal('p1', { outcome: 'Ship it', sessionId: SESSION });
    expect(created).toMatchObject({ slug: 'ship-it', sessionId: SESSION });
    // GOAL.md already exists: nothing is written, no second heartbeat is armed, and the first wake reuses its id (the server dedupes it).
    expect(requested.filter((r) => r.method === 'PUT' || (r.method === 'POST' && r.key.endsWith('/reminders')))).toEqual([]);
    expect(JSON.parse(requested.find((r) => r.key.endsWith('/prompts'))!.body).client_message_id).toBe(`goal-start:${SESSION}`);
  });

  test('with no agent named, the owner is the default agent unless it is My Kortix (no Files), else the first agent with Files', async () => {
    drive();
    put('/Users/u1/Goals/ship-it/GOAL.md');
    put('/Users/u1/Goals/ship-it/log.md');
    sessionCreated();
    await createProjectGoal('p1', { outcome: 'Ship it', sessionId: SESSION });
    const create = JSON.parse(requested.find((r) => r.method === 'POST' && r.key === '/projects/p1/sessions')!.body);
    expect(create.agent_name).toBe('billing');
    expect(parseGoalFile(requested.find((r) => r.method === 'PUT' && r.key.endsWith('GOAL.md'))!.body)?.agent).toBe('billing');

    requested = [];
    roster('worker', [
      { name: 'mykortix', platform: true, sandbox: 'mykortix' },
      { name: 'billing' },
      { name: 'worker' },
    ]);
    await createProjectGoal('p1', { outcome: 'Ship it', sessionId: SESSION });
    expect(JSON.parse(requested.find((r) => r.method === 'POST' && r.key === '/projects/p1/sessions')!.body).agent_name).toBe('worker');
  });

  test('createProjectGoal refuses My Kortix and a project with no agent that has Files', async () => {
    drive();
    await expect(createProjectGoal('p1', { outcome: 'Ship it', agent: 'mykortix' })).rejects.toThrow('cannot work a goal');
    roster('mykortix', [{ name: 'mykortix', platform: true, sandbox: 'mykortix' }, { name: 'old', enabled: false }, { name: 'bot', hidden: true }]);
    await expect(createProjectGoal('p1', { outcome: 'Ship it' })).rejects.toThrow('no agent');
    expect(requested.some((r) => r.method !== 'GET')).toBe(false);
  });

  test('a retry with an edited outcome reuses the folder the session already owns', async () => {
    drive();
    routes[`/projects/p1/sessions/${SESSION}`] = { status: 200, body: { session_id: SESSION, metadata: { goal: '/drives/me/Goals/ship-it' } } };
    routes['/drives/d1/files/content?path=/Users/u1/Goals/ship-it/GOAL.md'] = {
      status: 200,
      body: formatGoalFile({ ...GOAL, objective: 'Ship it', sessions: [{ id: SESSION, role: 'owner', since: '2026-11-01T00:00:00Z' }] }),
    };
    routes['/drives/d1/files/content?path=/Users/u1/Goals/ship-it/log.md'] = { status: 200, body: '# Log\n' };
    routes['POST /projects/p1/sessions'] = { status: 409, body: { error: 'Session already exists' } };
    routes[`POST /projects/p1/sessions/${SESSION}/prompts`] = { status: 200, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: true } };
    const created = await createProjectGoal('p1', { outcome: 'Ship it this week instead', sessionId: SESSION });
    expect(created.slug).toBe('ship-it');
    expect(requested.filter((r) => r.method === 'PUT' || r.key.endsWith('/reminders'))).toEqual([]);
  });

  test('a retry whose log.md upload failed creates log.md without touching GOAL.md', async () => {
    drive();
    routes['/drives/d1/files/content?path=/Users/u1/Goals/ship-it/GOAL.md'] = {
      status: 200,
      body: formatGoalFile({ ...GOAL, objective: 'Ship it', sessions: [{ id: SESSION, role: 'owner', since: '2026-11-01T00:00:00Z' }] }),
    };
    put('/Users/u1/Goals/ship-it/log.md');
    routes['POST /projects/p1/sessions'] = { status: 409, body: { error: 'Session already exists' } };
    routes[`POST /projects/p1/sessions/${SESSION}/prompts`] = { status: 200, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: true } };
    await createProjectGoal('p1', { outcome: 'Ship it', sessionId: SESSION });
    expect(requested.filter((r) => r.method === 'PUT').map((r) => r.key.split('/').at(-1))).toEqual(['log.md']);
  });

  test('createProjectGoal refuses an empty outcome, more than 8 criteria, and a project with no personal folder', async () => {
    await expect(createProjectGoal('p1', { outcome: '   ' })).rejects.toThrow('outcome');
    await expect(createProjectGoal('p1', { outcome: 'x', criteria: Array.from({ length: 9 }, (_, i) => `c${i}`) })).rejects.toThrow('8');
    drive();
    routes['/drives'] = { status: 200, body: { drives: [{ driveId: 'd1', projectId: 'p1', personalFolder: null }] } };
    await expect(createProjectGoal('p1', { outcome: 'x' })).rejects.toThrow('personal folder');
  });

  const OPEN_DOC: ProjectGoalDocument = {
    ...GOAL,
    status: 'active',
    items: [],
    sessions: [{ id: 's-owner', role: 'owner', since: '2026-10-21T10:00:00Z' }],
  };
  const goalRef = {
    driveId: 'd1',
    folder: '/Company/Goals/bank-close',
    scope: 'company' as const,
    slug: 'bank-close',
    coordinatorSessionId: 's-owner',
    heartbeat: { ...HEARTBEAT, session_id: 's-owner' },
  };
  const goalRoutes = (doc: ProjectGoalDocument) => {
    routes['/drives/d1/files/content?path=/Company/Goals/bank-close/GOAL.md'] = { status: 200, body: formatGoalFile(doc) };
    routes['/drives/d1/files/content?path=/Company/Goals/bank-close/log.md'] = { status: 200, body: '# Log\n' };
    put('/Company/Goals/bank-close/GOAL.md');
    put('/Company/Goals/bank-close/log.md');
  };

  test('pauseProjectGoal records the pause in GOAL.md on the version it read, logs it and disables the heartbeat', async () => {
    goalRoutes(OPEN_DOC);
    routes[`PATCH /projects/p1/sessions/s-owner/reminders/${HEARTBEAT.id}`] = { status: 200, body: { ...HEARTBEAT, state: 'paused' } };
    const doc = await pauseProjectGoal('p1', goalRef, 'Waiting for the new budget');
    expect(doc).toMatchObject({ status: 'active', paused_by: 'person' });
    expect(typeof doc.paused_at).toBe('string');
    const goalPut = requested.find((r) => r.method === 'PUT' && r.key.endsWith('GOAL.md'))!;
    expect(goalPut.ifMatch).toBe('v1');
    expect(parseGoalFile(goalPut.body)?.paused_at).toBe(doc.paused_at);
    expect(requested.find((r) => r.method === 'PUT' && r.key.endsWith('log.md'))!.body).toContain('paused: Waiting for the new budget');
    expect(JSON.parse(requested.find((r) => r.method === 'PATCH')!.body)).toEqual({ enabled: false });
  });

  test('pauseProjectGoal refuses a closed goal', async () => {
    goalRoutes({ ...OPEN_DOC, status: 'done' });
    await expect(pauseProjectGoal('p1', goalRef, 'x')).rejects.toThrow('already done');
  });

  test('a retry of a pause whose heartbeat update failed only finishes the heartbeat', async () => {
    goalRoutes({ ...OPEN_DOC, paused_at: '2026-11-01T00:00:00Z', paused_by: 'person' });
    routes[`PATCH /projects/p1/sessions/s-owner/reminders/${HEARTBEAT.id}`] = { status: 200, body: { ...HEARTBEAT, state: 'paused' } };
    const doc = await pauseProjectGoal('p1', goalRef, 'x');
    expect(doc.paused_at).toBe('2026-11-01T00:00:00Z');
    expect(requested.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(JSON.parse(requested.find((r) => r.method === 'PATCH')!.body)).toEqual({ enabled: false });
  });

  test('resumeProjectGoal clears the pause, re-enables the heartbeat and wakes the owner now', async () => {
    goalRoutes({ ...OPEN_DOC, paused_at: '2026-11-01T00:00:00Z', paused_by: 'person' });
    routes[`PATCH /projects/p1/sessions/s-owner/reminders/${HEARTBEAT.id}`] = { status: 200, body: HEARTBEAT };
    routes['POST /projects/p1/sessions/s-owner/prompts'] = {
      status: 202,
      body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false },
    };
    const doc = await resumeProjectGoal('p1', { ...goalRef, heartbeat: { ...goalRef.heartbeat, state: 'paused' } });
    expect(doc).toMatchObject({ paused_at: null, paused_by: null });
    expect(JSON.parse(requested.find((r) => r.method === 'PATCH')!.body)).toEqual({ enabled: true });
    const wakeBody = JSON.parse(requested.find((r) => r.method === 'POST')!.body);
    const wake = wakeBody.parts[0].text as string;
    expect(wake).toContain('Goal wake: /drives/company/Goals/bank-close.');
    // One wake per pause: a retry reuses the id and the server dedupes it.
    expect(wakeBody.client_message_id).toBe('goal-resume:s-owner:2026-11-01T00:00:00Z');
    expect(requested.find((r) => r.method === 'PUT' && r.key.endsWith('log.md'))!.body).toContain('resumed');
  });

  test('a retry of a resume whose heartbeat update failed re-enables the heartbeat and writes nothing', async () => {
    goalRoutes(OPEN_DOC);
    routes[`PATCH /projects/p1/sessions/s-owner/reminders/${HEARTBEAT.id}`] = { status: 200, body: HEARTBEAT };
    routes['POST /projects/p1/sessions/s-owner/prompts'] = { status: 202, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: true } };
    await resumeProjectGoal('p1', { ...goalRef, heartbeat: { ...goalRef.heartbeat, state: 'paused' } });
    expect(requested.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(JSON.parse(requested.find((r) => r.method === 'PATCH')!.body)).toEqual({ enabled: true });
  });

  test('resume enables the heartbeat before it clears the pause, so a failed GOAL.md write leaves nothing half-done', async () => {
    goalRoutes({ ...OPEN_DOC, paused_at: '2026-11-01T00:00:00Z', paused_by: 'person' });
    routes[`PATCH /projects/p1/sessions/s-owner/reminders/${HEARTBEAT.id}`] = { status: 200, body: HEARTBEAT };
    routes['PUT /drives/d1/files/content?path=/Company/Goals/bank-close/GOAL.md'] = { status: 409, body: { code: 'file_changed' } };
    await expect(resumeProjectGoal('p1', { ...goalRef, heartbeat: { ...goalRef.heartbeat, state: 'paused' } })).rejects.toMatchObject({ status: 409 });
    expect(requested.filter((r) => r.method !== 'GET').map((r) => r.method)).toEqual(['PATCH', 'PUT']);
  });

  test('a resume retry with no active heartbeat still wakes the owner, so the goal is never left idle', async () => {
    goalRoutes(OPEN_DOC);
    routes['POST /projects/p1/sessions/s-owner/prompts'] = { status: 202, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false } };
    await resumeProjectGoal('p1', { ...goalRef, heartbeat: null });
    expect(requested.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(JSON.parse(requested.find((r) => r.method === 'POST')!.body).parts[0].text).toContain('Goal wake: /drives/company/Goals/bank-close.');
  });

  test('a paused goal is healthy: its disabled heartbeat is the pause, not a problem', () => {
    const paused = { ...OPEN_DOC, paused_at: '2026-11-01T00:00:00Z' };
    expect(goalHealth(paused, { ...HEARTBEAT, state: 'paused' }, NOW)).toEqual({ state: 'healthy', issues: [] });
    expect(goalHealth(paused, null, NOW)).toEqual({ state: 'healthy', issues: [] });
  });

  test('paused_at alone is not a pause: a goal whose heartbeat still runs is judged like any other', () => {
    const claimed = { ...OPEN_DOC, paused_at: '2026-11-01T00:00:00Z' };
    expect(goalHealth(claimed, { ...HEARTBEAT, last_status: 'failed', last_error: 'x' }, NOW).issues).toEqual(['heartbeat_failed']);
  });

  test('stopping a paused goal clears the pause', async () => {
    goalRoutes({ ...OPEN_DOC, paused_at: '2026-11-01T00:00:00Z', paused_by: 'person' });
    routes[`DELETE /projects/p1/sessions/s-owner/reminders/${HEARTBEAT.id}`] = { status: 200, body: { ok: true } };
    const doc = await stopProjectGoal('p1', goalRef, 'Dropped');
    expect(doc).toMatchObject({ status: 'stopped', paused_at: null, paused_by: null });
  });

  const STOPPED_DOC: ProjectGoalDocument = {
    ...OPEN_DOC,
    status: 'stopped',
    reminder_id: null,
    next_wake_at: null,
    transitions: [
      ...OPEN_DOC.transitions,
      { from: 'active', to: 'stopped', at: '2026-11-02T09:00:00Z', reason: 'Stopped from the Goal page', by: 'person' },
    ],
  };

  test('restartProjectGoal moves a stopped goal back to active on the version it read, logs it and wakes the owner once per stop', async () => {
    goalRoutes(STOPPED_DOC);
    routes['POST /projects/p1/sessions/s-owner/prompts'] = { status: 202, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false } };
    const doc = await restartProjectGoal('p1', { ...goalRef, heartbeat: null }, 'Started again from the Goal page');
    expect(doc.status).toBe('active');
    expect(doc.transitions.at(-1)).toMatchObject({ from: 'stopped', to: 'active', reason: 'Started again from the Goal page', by: 'person' });
    const goalPut = requested.find((r) => r.method === 'PUT' && r.key.endsWith('GOAL.md'))!;
    expect(goalPut.ifMatch).toBe('v1');
    expect(parseGoalFile(goalPut.body)?.status).toBe('active');
    expect(requested.find((r) => r.method === 'PUT' && r.key.endsWith('log.md'))!.body).toContain('stopped → active: Started again from the Goal page');
    // GOAL.md first, then the wake: the owner never wakes on a goal that still reads stopped.
    expect(requested.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.key.split('?')[0]}`)).toEqual([
      'PUT /drives/d1/files/content',
      'PUT /drives/d1/files/content',
      'POST /projects/p1/sessions/s-owner/prompts',
    ]);
    const wake = JSON.parse(requested.find((r) => r.method === 'POST')!.body);
    expect(wake.parts[0].text).toContain('Goal wake: /drives/company/Goals/bank-close.');
    expect(wake.client_message_id).toBe('goal-restart:s-owner:2026-11-02T09:00:00Z');
  });

  test('restartProjectGoal sends a stopped goal with no done criteria back to draft, so the owner writes them first', async () => {
    goalRoutes({ ...STOPPED_DOC, success_criteria: [] });
    routes['POST /projects/p1/sessions/s-owner/prompts'] = { status: 202, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false } };
    const doc = await restartProjectGoal('p1', { ...goalRef, heartbeat: null }, 'again');
    expect(doc.status).toBe('draft');
  });

  test('a retry of a restart whose wake failed writes nothing and wakes the owner with the same id', async () => {
    const restarted = { ...STOPPED_DOC, status: 'active' as const, transitions: [...STOPPED_DOC.transitions, { from: 'stopped' as const, to: 'active' as const, at: '2026-11-03T09:00:00Z', reason: 'again', by: 'person' }] };
    goalRoutes(restarted);
    routes['POST /projects/p1/sessions/s-owner/prompts'] = { status: 202, body: { prompt_id: 'pr1', state: 'queued', message_id: 'm', deduped: false } };
    const doc = await restartProjectGoal('p1', { ...goalRef, heartbeat: null }, 'again');
    expect(doc.status).toBe('active');
    expect(requested.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(JSON.parse(requested.find((r) => r.method === 'POST')!.body).client_message_id).toBe('goal-restart:s-owner:2026-11-02T09:00:00Z');
  });

  test('restartProjectGoal refuses a goal that is not stopped and still has a live heartbeat', async () => {
    goalRoutes(OPEN_DOC);
    await expect(restartProjectGoal('p1', goalRef, 'x')).rejects.toThrow('not stopped');
    goalRoutes({ ...OPEN_DOC, status: 'done' });
    await expect(restartProjectGoal('p1', goalRef, 'x')).rejects.toThrow('not stopped');
    expect(requested.some((r) => r.method !== 'GET')).toBe(false);
  });

  test('createProjectGoal names the goal after the first line of a brief and keeps the whole brief in GOAL.md', async () => {
    drive();
    put('/Users/u1/Goals/draft-our-investor-update-for/GOAL.md');
    put('/Users/u1/Goals/draft-our-investor-update-for/log.md');
    sessionCreated();
    const brief = 'Draft our investor update for October.\n- Highlights: two launches\n- Asks: intros to CFOs\nCompare every number with the prior period.';
    const created = await createProjectGoal('p1', { outcome: brief, sessionId: SESSION });
    expect(created.slug).toBe('draft-our-investor-update-for');
    const doc = parseGoalFile(requested.find((r) => r.method === 'PUT' && r.key.endsWith('GOAL.md'))!.body)!;
    expect(doc.objective).toBe('Draft our investor update for October.');
    // The title is the heading, not repeated; a sentence after the list stays its own paragraph.
    expect(doc.body).toBe(
      '# Draft our investor update for October.\n\n## Context\n\n- Highlights: two launches\n- Asks: intros to CFOs\n\nCompare every number with the prior period.\n',
    );
    expect(JSON.parse(requested.find((r) => r.method === 'POST' && r.key === '/projects/p1/sessions')!.body).name).toBe('Draft our investor update for October.');
  });

  test('paused_at and paused_by round-trip through GOAL.md', () => {
    const doc = { ...OPEN_DOC, paused_at: '2026-11-01T00:00:00Z', paused_by: 'person', body: '' };
    expect(parseGoalFile(formatGoalFile(doc))).toMatchObject({ paused_at: '2026-11-01T00:00:00Z', paused_by: 'person' });
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

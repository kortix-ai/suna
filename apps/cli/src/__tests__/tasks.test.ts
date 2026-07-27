import { expect, test } from 'bun:test';

import { ApiError } from '../api/client.ts';
import {
  assigneeLabel,
  blockedStatusChange,
  buildRequestBody,
  buildTaskListQuery,
  buildWaitingQuery,
  deliveryLabel,
  formatAge,
  mergeBlockedBy,
  parseAssigneeSpec,
  renderRequestTable,
  renderTaskTable,
  requireTaskId,
  runTasks,
  shortId,
  surfaceConflict,
  type AgiRequest,
  type AgiTask,
} from '../commands/tasks.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';

/** Run a command with both streams captured so a usage error doesn't pollute
 *  the test output, and so we can assert on what it printed. */
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runTasks(argv);
    return { code, out, err };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('--label maps to the API `project` param and --project never reaches the query', () => {
  expect(buildTaskListQuery({ label: 'infra' })).toBe('?project=infra');
  expect(buildTaskListQuery({ label: 'none' })).toBe('?project=none');
  // --project is the workspace flag, consumed before the query is built — no
  // filter combination can emit it.
  expect(buildTaskListQuery({ status: 'open', goal: 'g' })).not.toContain('project=');
  expect(buildTaskListQuery({})).toBe('');
});

test('list filters serialize in the API vocabulary', () => {
  expect(
    buildTaskListQuery({ status: 'open', goal: 'ship-v1', claim: 'free', limit: '25' }),
  ).toBe('?status=open&goal=ship-v1&claim=free&limit=25');
  expect(buildTaskListQuery({ parent: 'none' })).toBe('?parent=none');
  expect(buildTaskListQuery({ parent: A })).toBe(`?parent=${A}`);
  expect(buildTaskListQuery({ blockedBy: A })).toBe(`?blocked_by=${A}`);
});

test('out-of-range limits, bad claim states, and truncated ids are usage errors', () => {
  expect(() => buildTaskListQuery({ limit: '0' })).toThrow('--limit');
  expect(() => buildTaskListQuery({ limit: '201' })).toThrow('--limit');
  expect(() => buildTaskListQuery({ limit: '5.5' })).toThrow('--limit');
  expect(() => buildTaskListQuery({ claim: 'maybe' })).toThrow('--claim');
  expect(() => buildTaskListQuery({ parent: '11111111' })).toThrow('pass the full task id');
  expect(() => requireTaskId(A.slice(0, 8))).toThrow('pass the full task id');
  expect(requireTaskId(A)).toBe(A);
});

test('assignee specs accept the four documented forms and nothing else', () => {
  expect(parseAssigneeSpec('none')).toBe('none');
  expect(parseAssigneeSpec('any')).toBe('any');
  expect(parseAssigneeSpec('agent:builder')).toBe('agent:builder');
  expect(parseAssigneeSpec(`user:${A}`)).toBe(`user:${A}`);
  expect(() => parseAssigneeSpec('agent:')).toThrow('needs a name');
  expect(() => parseAssigneeSpec('user:nope')).toThrow('pass the full task id');
  expect(() => parseAssigneeSpec('builder')).toThrow('--assignee must be');
});

test('block merges preserve existing order, drop --off, and de-duplicate', () => {
  expect(mergeBlockedBy([A, B], [D], [])).toEqual([A, B, D]);
  expect(mergeBlockedBy([A, B, D], [], [B])).toEqual([A, D]);
  expect(mergeBlockedBy([A, B], [A], [])).toEqual([A, B]);
  expect(mergeBlockedBy([A, A, B], [], [])).toEqual([A, B]);
  expect(mergeBlockedBy([], [], [A])).toEqual([]);
});

test('the block status side effect fires only under the stated conditions', () => {
  expect(blockedStatusChange('todo', [A])).toBe('blocked');
  expect(blockedStatusChange('doing', [A])).toBe('blocked');
  expect(blockedStatusChange('blocked', [A])).toBeUndefined();
  expect(blockedStatusChange('done', [A])).toBeUndefined();
  expect(blockedStatusChange('cancelled', [A])).toBeUndefined();
  expect(blockedStatusChange('blocked', [])).toBe('todo');
  expect(blockedStatusChange('todo', [])).toBeUndefined();
  expect(blockedStatusChange('done', [])).toBeUndefined();
});

test('ids render truncated to 8 chars and assignees to their one-owner label', () => {
  expect(shortId(A)).toBe('11111111');
  expect(assigneeLabel({ agent: 'builder', assignee_user_id: null })).toBe('@builder');
  expect(assigneeLabel({ agent: null, assignee_user_id: B })).toBe('u:22222222');
  expect(assigneeLabel({ agent: null, assignee_user_id: null })).toBe('-');
});

test('a 409 exits 3 and anything else is left to the ordinary error path', () => {
  const conflict = new ApiError(409, 'Task is claimed by another session', {
    error: 'Task is claimed by another session',
    code: 'claim_conflict',
  });
  const originalErr = process.stderr.write;
  let err = '';
  process.stderr.write = ((chunk: string) => {
    err += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    expect(surfaceConflict(conflict)).toBe(3);
    expect(surfaceConflict(new ApiError(404, 'Not found'))).toBeNull();
    expect(surfaceConflict(new Error('boom'))).toBeNull();
  } finally {
    process.stderr.write = originalErr;
  }
  expect(err).toContain('claimed by another session');
});

test('--agent with --assignee-user is a usage error before any network call', async () => {
  const { code, err } = await capture([
    'new',
    'fix',
    'the',
    'thing',
    '--agent',
    'builder',
    '--assignee-user',
    B,
  ]);
  expect(code).toBe(2);
  expect(err).toContain('at most one assignee');
});

test('--doing with --review is a usage error before any network call', async () => {
  const { code, err } = await capture(['claim', A, '--doing', '--review']);
  expect(code).toBe(2);
  expect(err).toContain('--doing or --review');
});

test('a truncated task id is a usage error, not a lookup', async () => {
  const { code, err } = await capture(['show', '11111111']);
  expect(code).toBe(2);
  expect(err).toContain('pass the full task id');
});

test('claim outside a session with no --session is a usage error', async () => {
  const previous = process.env.KORTIX_SESSION_ID;
  delete process.env.KORTIX_SESSION_ID;
  try {
    const { code, err } = await capture(['claim', A]);
    expect(code).toBe(2);
    expect(err).toContain('--session is required');
  } finally {
    if (previous !== undefined) process.env.KORTIX_SESSION_ID = previous;
  }
});

test('block with neither --on nor --off is a usage error', async () => {
  const { code, err } = await capture(['block', A]);
  expect(code).toBe(2);
  expect(err).toContain('--on');
});

test('a bare --help on a subcommand prints usage instead of being read as an id', async () => {
  const { code, out } = await capture(['show', '--help']);
  expect(code).toBe(0);
  expect(out).toContain('kortix tasks');
});

test('the ready view serializes to the one param the API reads', () => {
  expect(buildTaskListQuery({ ready: true })).toBe('?ready=1');
  // Absence IS "not the ready view" — never `ready=0`, which would be a second
  // filter the caller did not ask for.
  expect(buildTaskListQuery({ ready: false })).toBe('');
  expect(buildTaskListQuery({ ready: true, status: 'open' })).toBe('?status=open&ready=1');
});

test('priority filters accept the vocabulary as a list and nothing outside it', () => {
  expect(buildTaskListQuery({ priority: 'urgent' })).toBe('?priority=urgent');
  expect(buildTaskListQuery({ priority: 'urgent,high' })).toBe('?priority=urgent%2Chigh');
  expect(buildTaskListQuery({ priority: ' urgent , high ' })).toBe('?priority=urgent%2Chigh');
  expect(() => buildTaskListQuery({ priority: 'critical' })).toThrow('--priority');
  expect(() => buildTaskListQuery({ priority: 'high,critical' })).toThrow('--priority');
});

test('--idle is a whole number of days and maps to the API param name', () => {
  expect(buildTaskListQuery({ idle: '7' })).toBe('?idle_days=7');
  expect(() => buildTaskListQuery({ idle: '0' })).toThrow('--idle');
  expect(() => buildTaskListQuery({ idle: '-3' })).toThrow('--idle');
  expect(() => buildTaskListQuery({ idle: '1.5' })).toThrow('--idle');
});

test('age renders at the resolution that matters, from seconds to years', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  expect(formatAge('2026-07-26T11:59:31.000Z', now)).toBe('now');
  expect(formatAge('2026-07-26T11:45:00.000Z', now)).toBe('15m');
  expect(formatAge('2026-07-26T04:00:00.000Z', now)).toBe('8h');
  expect(formatAge('2026-07-05T12:00:00.000Z', now)).toBe('21d');
  expect(formatAge('2025-07-26T12:00:00.000Z', now)).toBe('365d');
  // A clock skew that puts the row in the future must not render as negative.
  expect(formatAge('2026-07-26T12:05:00.000Z', now)).toBe('now');
  expect(formatAge('not a date', now)).toBe('-');
});

test('the table carries an IDLE column so a stalled task is visible in the list', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  const task: AgiTask = {
    task_id: A,
    workspace_id: B,
    parent_id: null,
    goal_slug: 'ship-v1',
    project: null,
    title: 'nobody has touched this',
    body: null,
    status: 'todo',
    priority: 'high',
    agent: null,
    assignee_user_id: null,
    blocked_by: [],
    trigger_slug: null,
    claim_session_id: null,
    claimed_at: null,
    claim_expires_at: null,
    claimed: false,
    origin: 'agi',
    origin_fingerprint: null,
    created_at: '2026-06-01T12:00:00.000Z',
    updated_at: '2026-07-04T12:00:00.000Z',
  };
  const table = renderTaskTable([task], now);
  expect(table).toContain('IDLE');
  expect(table).toContain('22d');
});

test('`ready` is a list view, so it validates list flags before any network call', async () => {
  const { code, err } = await capture(['ready', '--priority', 'critical']);
  expect(code).toBe(2);
  expect(err).toContain('--priority');
});

test('no subcommand exits 2, an unknown one exits 2 with the help text', async () => {
  expect((await capture([])).code).toBe(2);
  const { code, err } = await capture(['frobnicate']);
  expect(code).toBe(2);
  expect(err).toContain('unknown subcommand');
});

// ── Reaching a human when nobody is watching (spec §4.3, R-12g) ─────────────

test('`request` needs a one-line need — an ask with no subject is not an ask', () => {
  expect(() => buildRequestBody({})).toThrow('--need');
  expect(() => buildRequestBody({ need: '   ' })).toThrow('--need');
  expect(buildRequestBody({ need: 'AHREFS_API_KEY' })).toEqual({
    kind: 'secret',
    need: 'AHREFS_API_KEY',
  });
});

test('`--url` REFUSES a credential, and says what to do instead', () => {
  // The control that matters. `--url` is the one free-form field an agent fills
  // in, and the failure it guards is an agent that passed the key itself — which
  // would then be direct-messaged to a human in plain text.
  for (const pasted of ['sk-live-abc123', 'ghp_deadbeef', 'AIzaSyDeadBeef', 'ftp://host/key']) {
    expect(() => buildRequestBody({ need: 'X', url: pasted })).toThrow('http(s) link');
  }
  expect(() => buildRequestBody({ need: 'X', url: 'sk-live-abc' })).toThrow('kortix secrets request');
  expect(buildRequestBody({ need: 'X', url: 'https://app.kortix.test/setup/a' }).url).toBe(
    'https://app.kortix.test/setup/a',
  );
});

test('`--kind` is closed, and defaults to the commonest block', () => {
  expect(buildRequestBody({ need: 'X' }).kind).toBe('secret');
  expect(buildRequestBody({ need: 'X', kind: 'decision' }).kind).toBe('decision');
  expect(() => buildRequestBody({ need: 'X', kind: 'approval' })).toThrow('--kind');
});

test('`--to` must be a user id, and the session is picked up from the environment', () => {
  expect(() => buildRequestBody({ need: 'X', to: 'marko' })).toThrow('--to');
  expect(buildRequestBody({ need: 'X', to: A }).responder_user_id).toBe(A);

  const previous = process.env.KORTIX_SESSION_ID;
  process.env.KORTIX_SESSION_ID = 'ses_push';
  try {
    // The session that hit the wall is evidence a human needs, and inside an
    // unattended run it is already in the environment — never make the agent
    // remember to pass it.
    expect(buildRequestBody({ need: 'X' }).session_id).toBe('ses_push');
    expect(buildRequestBody({ need: 'X', session: 'ses_explicit' }).session_id).toBe('ses_explicit');
  } finally {
    if (previous === undefined) delete process.env.KORTIX_SESSION_ID;
    else process.env.KORTIX_SESSION_ID = previous;
  }
});

test('`waiting` defaults to YOUR queue — an inbox showing everyone is a feed', () => {
  expect(buildWaitingQuery({})).toBe('?responder=me');
  expect(buildWaitingQuery({ mine: true })).toBe('?responder=me');
  expect(buildWaitingQuery({ all: true })).toBe('');
  expect(buildWaitingQuery({ to: A })).toBe(`?responder=${A}`);
});

test('`--undelivered` carries no responder — an ask that reached nobody has none', () => {
  // Scoping it to "mine" would always return nothing and hide the one list that
  // means "the system tried to reach a human and could not".
  expect(buildWaitingQuery({ undelivered: true })).toBe('?undelivered=1');
  expect(buildWaitingQuery({ undelivered: true, mine: true })).toBe('?undelivered=1');
});

test('`waiting` rejects contradictory scopes and bad values before any network call', () => {
  expect(() => buildWaitingQuery({ all: true, to: A })).toThrow('not both');
  expect(() => buildWaitingQuery({ all: true, mine: true })).toThrow('not both');
  expect(() => buildWaitingQuery({ to: 'nope' })).toThrow('--to');
  expect(() => buildWaitingQuery({ status: 'maybe' })).toThrow('--status');
  expect(() => buildWaitingQuery({ limit: '0' })).toThrow('--limit');
  expect(() => buildWaitingQuery({ task: 'abc' })).toThrow('full task id');
  expect(buildWaitingQuery({ status: 'all', limit: '10' })).toBe(
    '?responder=me&status=all&limit=10',
  );
});

test('an undelivered ask reads as NOBODY, never as a delivery method', () => {
  expect(deliveryLabel({ delivered_via: 'slack', delivered_at: '2026-07-27T07:00:00Z' })).toBe(
    'slack',
  );
  expect(deliveryLabel({ delivered_via: 'inbox', delivered_at: '2026-07-27T07:00:00Z' })).toBe(
    'inbox',
  );
  expect(deliveryLabel({ delivered_via: null, delivered_at: null })).toBe('NOBODY');
});

test('the inbox table leads with AGE and names the work each ask is blocking', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const request: AgiRequest & { task_title: string | null } = {
    request_id: A,
    workspace_id: B,
    task_id: D,
    kind: 'secret',
    need: 'GOOGLE_SEARCH_CONSOLE_TOKEN',
    why: null,
    url: 'https://app.kortix.test/setup/abc',
    responder_user_id: B,
    status: 'pending',
    delivered_at: '2026-07-25T12:00:00.000Z',
    delivered_via: 'slack',
    live: true,
    requested_by_session_id: 'ses_push',
    origin_fingerprint: 'agi-request:v1:abc',
    satisfied_at: null,
    satisfied_by_user_id: null,
    created_at: '2026-07-25T12:00:00.000Z',
    updated_at: '2026-07-25T12:00:00.000Z',
    task_title: 'Measure the core terms',
  };
  const table = renderRequestTable([request], now);
  expect(table).toContain('AGE');
  // How long a person has been sitting on it is the number that matters.
  expect(table).toContain('2d');
  expect(table).toContain('GOOGLE_SEARCH_CONSOLE_TOKEN');
  expect(table).toContain('Measure the core terms');
  expect(table).toContain('slack');
});

test('`request` validates before any network call, and `answer` wants a full id', async () => {
  const bad = await capture(['request', A, '--need', 'X', '--url', 'sk-live-abc']);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain('http(s) link');

  const noNeed = await capture(['request', A]);
  expect(noNeed.code).toBe(2);
  expect(noNeed.err).toContain('--need');

  const noTask = await capture(['request', '--need', 'X']);
  expect(noTask.code).toBe(2);
  expect(noTask.err).toContain('task id');

  const noId = await capture(['answer']);
  expect(noId.code).toBe(2);
  expect(noId.err).toContain('request id');

  const shortIdArg = await capture(['answer', '1234abcd']);
  expect(shortIdArg.code).toBe(2);
  expect(shortIdArg.err).toContain('full request id');
});

test('`waiting` validates its scope before any network call', async () => {
  const { code, err } = await capture(['waiting', '--all', '--to', A]);
  expect(code).toBe(2);
  expect(err).toContain('not both');
});

test('the help text tells an agent that a session log is not delivery', async () => {
  const { out } = await capture(['--help']);
  expect(out).toContain('request <task-id>');
  expect(out).toContain('waiting');
  expect(out).toContain('answer <request-id>');
  expect(out).toContain('NOT');
});

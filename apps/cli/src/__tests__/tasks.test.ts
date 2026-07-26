import { expect, test } from 'bun:test';

import { ApiError } from '../api/client.ts';
import {
  assigneeLabel,
  blockedStatusChange,
  buildTaskListQuery,
  mergeBlockedBy,
  parseAssigneeSpec,
  requireTaskId,
  runTasks,
  shortId,
  surfaceConflict,
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

test('no subcommand exits 2, an unknown one exits 2 with the help text', async () => {
  expect((await capture([])).code).toBe(2);
  const { code, err } = await capture(['frobnicate']);
  expect(code).toBe(2);
  expect(err).toContain('unknown subcommand');
});

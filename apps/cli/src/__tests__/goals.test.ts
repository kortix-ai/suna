import { expect, test } from 'bun:test';

import {
  buildGoalListQuery,
  formatGoalIssue,
  renderGoalTable,
  runGoals,
} from '../commands/goals.ts';
import type { AgiGoal } from '../commands/tasks.ts';
import { stripAnsi } from '../style.ts';

function goal(overrides: Partial<AgiGoal> = {}): AgiGoal {
  return {
    slug: 'ship-v1',
    title: 'Ship v1',
    done_when: 'The release is live.',
    status: 'active',
    push: '0 0 9 * * 1-5',
    agent: 'builder',
    trigger_slug: 'goal-ship-v1',
    open_task_count: 3,
    task_counts: { todo: 2, doing: 1 },
    ...overrides,
  };
}

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
    const code = await runGoals(argv);
    return { code, out, err };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('the status filter is passed through only for the four goal statuses', () => {
  expect(buildGoalListQuery()).toBe('');
  expect(buildGoalListQuery('active')).toBe('?status=active');
  expect(buildGoalListQuery('abandoned')).toBe('?status=abandoned');
  expect(() => buildGoalListQuery('open')).toThrow('--status must be one of');
});

test('manifest issues render with their index and optional slug', () => {
  expect(formatGoalIssue({ index: 0, slug: null, message: 'missing done_when' })).toBe(
    'goal[0]: missing done_when',
  );
  expect(formatGoalIssue({ index: 2, slug: 'ship-v1', message: 'unknown status' })).toBe(
    'goal[2] ship-v1: unknown status',
  );
});

test('the goal table carries slug, status, push, open count, and title', () => {
  const table = stripAnsi(renderGoalTable([goal(), goal({ slug: 'x', push: null, open_task_count: 0 })]));
  expect(table).toContain('SLUG');
  expect(table).toContain('PUSH');
  expect(table).toContain('OPEN');
  expect(table).toContain('0 0 9 * * 1-5');
  // A goal with no `push:` reads as a dash, not an empty column.
  expect(table).toMatch(/\n {2}x +active +- +0 +Ship v1/);
});

test('show and push without a slug are usage errors before any network call', async () => {
  const show = await capture(['show']);
  expect(show.code).toBe(2);
  expect(show.err).toContain('Pass a goal slug.');
  const push = await capture(['push']);
  expect(push.code).toBe(2);
  expect(push.err).toContain('Pass a goal slug.');
});

test('a bad --status is a usage error, not an API round trip', async () => {
  const { code, err } = await capture(['ls', '--status', 'open']);
  expect(code).toBe(2);
  expect(err).toContain('--status must be one of');
});

test('a bare --help on a subcommand prints usage instead of being read as a slug', async () => {
  const { code, out } = await capture(['show', '--help']);
  expect(code).toBe(0);
  expect(out).toContain('kortix goals');
});

test('no subcommand exits 2, an unknown one exits 2 with the help text', async () => {
  expect((await capture([])).code).toBe(2);
  const { code, err } = await capture(['frobnicate']);
  expect(code).toBe(2);
  expect(err).toContain('unknown subcommand');
});

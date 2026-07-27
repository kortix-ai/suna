import { expect, test } from 'bun:test';

import {
  buildGoalListQuery,
  buildObserveBody,
  directionMark,
  formatMetricValue,
  formatGoalIssue,
  goalMetricCell,
  measurabilityNotice,
  renderGoalTable,
  renderMetricTable,
  renderPushResult,
  renderSeries,
  runGoals,
} from '../commands/goals.ts';
import type { AgiGoal, AgiGoalMetric, AgiGoalMetricSeries } from '../commands/tasks.ts';
import { stripAnsi } from '../style.ts';

function point(value: number, observedAt = '2026-07-26T09:00:00.000Z') {
  return { value, observed_at: observedAt, source: 'session:s1' };
}

function metric(overrides: Partial<AgiGoalMetricSeries> = {}): AgiGoalMetricSeries {
  return {
    metric: 'rank',
    latest: point(9),
    previous: point(12),
    direction: 'up',
    flat_observations: 0,
    window_truncated: false,
    series: [point(12), point(9)],
    ...overrides,
  };
}

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
    metrics: [],
    measurability: 'unquantified',
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
  expect(table).toMatch(/\n {2}x +active +- +0 +- +Ship v1/);
});

test('the list METRIC cell shows the FLATTEST metric — the one closest to a stall', () => {
  const cell = goalMetricCell({
    measurability: 'measured',
    metrics: [
      { ...metric({ metric: 'signups', latest: point(40), direction: 'up' }) },
      { ...metric({ metric: 'rank', latest: point(9), direction: 'flat', flat_observations: 4 }) },
    ] as AgiGoalMetric[],
  });
  expect(cell).toBe('rank 9 → flat×4');
});

// R-12d: the distinction the whole section exists for. A goal with no readings
// must never render as a blank cell, which is indistinguishable from healthy.
test('an unmeasurable goal says so in the list instead of showing a blank cell', () => {
  expect(goalMetricCell({ metrics: [], measurability: 'unmeasurable' })).toBe('UNMEASURABLE');
  expect(goalMetricCell({ metrics: [], measurability: 'unquantified' })).toBe('-');
});

test('unmeasurable warns and names the verb that fixes it; unquantified is informational', () => {
  const warned = stripAnsi(measurabilityNotice({ slug: 'seo', measurability: 'unmeasurable' }));
  expect(warned).toContain('UNMEASURABLE');
  expect(warned).toContain('kortix goals observe seo --metric');

  const quiet = stripAnsi(measurabilityNotice({ slug: 'hire', measurability: 'unquantified' }));
  expect(quiet).toContain('no threshold');
  expect(quiet).not.toContain('UNMEASURABLE');
});

test('direction marks distinguish "flat" from "only one reading"', () => {
  expect(directionMark('up')).toBe('↑');
  expect(directionMark('down')).toBe('↓');
  expect(directionMark('flat')).toBe('→');
  expect(directionMark('unknown')).toBe('?');
});

test('metric values drop float noise but keep real decimals', () => {
  expect(formatMetricValue(9)).toBe('9');
  expect(formatMetricValue(9.300000000000001)).toBe('9.3');
  expect(formatMetricValue(-0.5)).toBe('-0.5');
});

test('the series preview keeps the NEWEST readings and marks what it dropped', () => {
  expect(renderSeries([])).toBe('-');
  expect(renderSeries([point(1), point(2), point(3)])).toBe('1 → 2 → 3');
  const long = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => point(v));
  const rendered = renderSeries(long);
  expect(rendered).toBe('… → 3 → 4 → 5 → 6 → 7 → 8');
});

test('the metric table carries the flat run as its own column', () => {
  const table = stripAnsi(
    renderMetricTable([
      metric({ metric: 'rank', latest: point(9), direction: 'flat', flat_observations: 3 }),
    ]),
  );
  expect(table).toContain('FLAT');
  expect(table).toMatch(/rank +9 +→ +3 +12 → 9/);
});

test('observe requires a metric and a finite value before any network call', async () => {
  expect(() => buildObserveBody({ value: '1' })).toThrow('--metric is required');
  expect(() => buildObserveBody({ metric: 'rank' })).toThrow('--value is required');
  // Number('') is 0 and Number('1e999') is Infinity — both would record a
  // reading nobody took.
  expect(() => buildObserveBody({ metric: 'rank', value: '' })).toThrow('--value is required');
  expect(() => buildObserveBody({ metric: 'rank', value: 'soon' })).toThrow('finite number');
  expect(() => buildObserveBody({ metric: 'rank', value: '1e999' })).toThrow('finite number');
});

test('observe passes the metric name through untouched — the server owns normalization', () => {
  // If the CLI folded the name too, a webhook posting directly could disagree
  // about which series a name belongs to.
  expect(buildObserveBody({ metric: 'Google Rank', value: '9' })).toEqual({
    metric: 'Google Rank',
    value: 9,
  });
});

test('observe omits source and observed_at unless given, so the server defaults apply', () => {
  expect(buildObserveBody({ metric: 'rank', value: '0' })).toEqual({ metric: 'rank', value: 0 });
  expect(buildObserveBody({ metric: 'rank', value: '9', source: 'cron', at: '2026-07-26T09:00:00Z' })).toEqual({
    metric: 'rank',
    value: 9,
    source: 'cron',
    observed_at: '2026-07-26T09:00:00.000Z',
  });
  expect(() => buildObserveBody({ metric: 'rank', value: '9', at: 'tuesday' })).toThrow('ISO-8601');
});

test('observe without a slug is a usage error before any network call', async () => {
  const { code, err } = await capture(['observe', '--metric', 'rank', '--value', '9']);
  expect(code).toBe(2);
  expect(err).toContain('Pass a goal slug.');
});

test('observe with a slug but no metric is a usage error, not a round trip', async () => {
  const { code, err } = await capture(['observe', 'seo']);
  expect(code).toBe(2);
  expect(err).toContain('--metric is required');
});

// A push is an ordinary trigger fire, and only ONE of its three outcomes has a
// session. Rendering `session_id` unconditionally printed the literal
// "session null" for the queued case, which is the case that happens under
// backpressure — exactly when a reader needs to be told something true.
test('a queued push renders the queue, not "session null"', () => {
  const queued = stripAnsi(
    renderPushResult('oil-desk', {
      status: 'queued',
      trigger_slug: 'goal-oil-desk',
      session_id: null,
      command_id: 'cmd-42',
      deduped: false,
      reason: 'provisioning sessions at capacity',
    }),
  );
  expect(queued).toContain('queued oil-desk');
  expect(queued).toContain('cmd-42');
  expect(queued).toContain('provisioning sessions at capacity');
  expect(queued).not.toContain('null');
});

test('a fired push names the session; a deduped one says so instead', () => {
  const fired = stripAnsi(
    renderPushResult('oil-desk', {
      status: 'fired',
      trigger_slug: 'goal-oil-desk',
      session_id: 'ses-1',
      command_id: null,
      deduped: false,
      reason: null,
    }),
  );
  expect(fired).toContain('pushed oil-desk');
  expect(fired).toContain('ses-1');

  const deduped = stripAnsi(
    renderPushResult('oil-desk', {
      status: 'deduped',
      trigger_slug: 'goal-oil-desk',
      session_id: 'ses-1',
      command_id: null,
      deduped: true,
      reason: 'already queued for this slot',
    }),
  );
  expect(deduped).toContain('already pushed oil-desk');
  expect(deduped).toContain('already queued for this slot');
});

// Belt and braces: `fired` with no session id is not a shape the API produces
// today, but the renderer must never print the word null if it ever does.
test('a fired push with no session id degrades to the bare line', () => {
  const rendered = stripAnsi(
    renderPushResult('oil-desk', {
      status: 'fired',
      trigger_slug: 'goal-oil-desk',
      session_id: null,
      command_id: null,
      deduped: false,
      reason: null,
    }),
  );
  expect(rendered).toBe('  ✓  pushed oil-desk');
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

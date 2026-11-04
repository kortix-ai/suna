import { describe, expect, test } from 'bun:test';
import { parseWorkflowRun, type WorkflowRun } from '@kortix/sdk';

import { runnerOutcome, workflowCardModel, workflowGroups } from './agents-workflow';

// The contract of apps/web tool/tools/workflow-run-card.tsx (Paper C19, F1–F5),
// asserted on the model the mobile card draws from.

const NOW = 1_790_000_471_000;

function run(overrides: Record<string, unknown> = {}): WorkflowRun {
  return parseWorkflowRun({
    runId: 'run-1',
    title: 'Kortix growth marketing deep dive',
    status: 'running',
    phases: [
      { title: 'Investigate', status: 'running' },
      { title: 'Build strategy', status: 'pending' },
    ],
    agents: [
      { id: 'a1', label: 'Product and website', phase: 'Investigate', status: 'done', sessionId: 'ses_1', startedAt: 1_790_000_000_000, endedAt: 1_790_000_357_000 },
      { id: 'a2', label: 'Customers and demand', phase: 'Investigate', status: 'running', sessionId: 'ses_2', startedAt: 1_790_000_000_000 },
      { id: 'a3', label: 'Competition', phase: 'Investigate', status: 'failed', sessionId: 'ses_3', summary: 'The site blocked the request' },
    ],
    startedAt: 1_790_000_000_000,
    ...overrides,
  })!;
}

describe('workflowCardModel', () => {
  test('a live run names the phase at work and the time; the ring counts the whole run', () => {
    const model = workflowCardModel(run(), { live: true, now: NOW, settled: false });
    expect(model.title).toBe('Kortix growth marketing deep dive');
    expect(model.subtitle).toBe('Investigate 1 of 3 done · 1 failed · 7m 51s');
    expect(model.ring).toEqual({ done: 1, failed: 1, total: 3, ended: null });
    expect(model.headerOnly).toBe(false);
  });

  test('ended background runs are the header alone, and say how they ended', () => {
    const done = run({ status: 'done', background: { sessionId: 'ses_runner' }, endedAt: 1_790_001_025_000 });
    const model = workflowCardModel(done, { live: false, now: NOW, settled: true });
    expect(model.subtitle).toBe('Done · 3 agents · 17m 05s');
    expect(model.ring.ended).toBe('done');
    expect(model.headerOnly).toBe(true);

    const failed = workflowCardModel(run({ status: 'failed', background: { sessionId: 'ses_runner' } }), { live: false, now: NOW, settled: true });
    expect(failed.subtitle).toBe('Didn’t finish · 1 of 3 done · 1 failed');
    expect(failed.failedTone).toBe(true);

    const stopped = workflowCardModel(run({ status: 'stopped' }), { live: false, now: NOW, settled: true });
    expect(stopped.subtitle).toBe('Stopped · 1 of 3 done');
    expect(stopped.ring.ended).toBe('stopped');
    // A foreground run keeps its rows: there is no run session to open them in.
    expect(stopped.headerOnly).toBe(false);
  });

  test('a call that returned while the run goes on says it runs in the background', () => {
    expect(workflowCardModel(run(), { live: false, now: NOW, settled: true }).subtitle.startsWith('Running in the background · Investigate')).toBe(true);
  });
});

describe('workflowGroups', () => {
  test('agents sit under their phase, failed first, then working, then done; a phase not started is one muted row', () => {
    const groups = workflowGroups(run(), true, NOW);
    expect(groups[0]).toMatchObject({ kind: 'phase', title: 'Investigate', progress: '1 of 3 done' });
    const rows = groups[0]!.kind === 'phase' ? groups[0]!.rows : [];
    expect(rows.map((row) => row.label)).toEqual(['Competition', 'Customers and demand', 'Product and website']);
    expect(rows[0]).toMatchObject({ state: 'Didn’t finish', failed: true, reason: 'The site blocked the request', time: null, glyph: 'failed' });
    expect(rows[1]).toMatchObject({ state: null, time: '7m 51s', glyph: 'running', sessionId: 'ses_2' });
    expect(rows[2]).toMatchObject({ state: null, time: '5m 57s', glyph: 'done' });
    expect(groups[1]).toEqual({ kind: 'pending', title: 'Build strategy', after: 'Investigate', waits: 'Waits for 1 more' });
  });
});

describe('runnerOutcome', () => {
  test('a runner session that finished, failed or stopped says so; one still working says nothing', () => {
    expect(runnerOutcome('done')).toBe('done');
    expect(runnerOutcome('failed')).toBe('failed');
    expect(runnerOutcome('stopped')).toBe('stopped');
    expect(runnerOutcome('running')).toBeNull();
    expect(runnerOutcome(null)).toBeNull();
  });
});

test('a running phase with no agent yet keeps its row, with no progress to show', () => {
  const groups = workflowGroups(
    { runId: 'r', title: 'Run', status: 'running', phases: [{ title: 'Plan', status: 'running' }], agents: [] } as never,
    true,
    0,
  );
  expect(groups).toEqual([
    { kind: 'phase', title: 'Plan', progress: null, ring: { done: 0, failed: 0, total: 0, ended: null }, failed: null, rows: [] },
  ]);
});

test('a done phase whose agent was stopped does not draw the done check', () => {
  const [group] = workflowGroups(
    {
      runId: 'r',
      title: 'Run',
      status: 'done',
      phases: [{ title: 'Plan', status: 'done' }],
      agents: [{ id: 'a', label: 'Draft', phase: 'Plan', status: 'stopped' }],
    } as never,
    false,
    0,
  );
  expect(group?.kind === 'phase' && group.ring.ended).toBeNull();
});

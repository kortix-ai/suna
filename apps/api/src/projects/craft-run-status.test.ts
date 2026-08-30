/**
 * `craftRunStatus` — the derivation that decides what a craft run SHOWS.
 *
 * Worth dense coverage because there is no stored success flag and the two
 * obvious candidates both lie: `project_trigger_executions.status` reads
 * `succeeded` as soon as a session exists (dispatch, not outcome), and
 * `project_sessions.status = 'completed'` is written by exactly one migration
 * backfill so a finished session never reaches it. Get this wrong and every
 * real run reports as unfinished, or every reaped sandbox reports as a failure.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CraftRunStatus,
  craftRunIsSettled,
  craftRunStats,
  craftRunStatus,
} from './craft-run-status';

function status(overrides: Partial<Parameters<typeof craftRunStatus>[0]> = {}): CraftRunStatus {
  return craftRunStatus({
    executionStatus: 'succeeded',
    attempts: 1,
    lastError: null,
    sessionStatus: 'stopped',
    lastTurnEndReason: 'completed',
    ...overrides,
  });
}

describe('craftRunStatus — dispatch states', () => {
  test('a fresh queued slot is starting', () => {
    expect(status({ executionStatus: 'queued', attempts: 0, lastError: null })).toBe('starting');
  });

  test('a queued slot that already burned an attempt is RETRYING, not starting', () => {
    // Collapsing this into `starting` would show a craft failing every attempt
    // as perpetually "starting" — the opposite of actionable.
    expect(status({ executionStatus: 'queued', attempts: 2, lastError: 'boom' })).toBe('retrying');
  });

  test('a queued slot with an error but no attempt count is still retrying', () => {
    expect(status({ executionStatus: 'queued', attempts: 0, lastError: 'boom' })).toBe('retrying');
  });

  test('running means being dispatched — starting', () => {
    expect(status({ executionStatus: 'running', sessionStatus: null })).toBe('starting');
  });

  test('skipped is its own state, not a failure', () => {
    // A filter declined the delivery, or the pause switch was on. Nothing ran
    // and nothing is wrong.
    expect(status({ executionStatus: 'skipped' })).toBe('skipped');
  });

  test('dead_lettered is the one execution status that IS a verdict', () => {
    expect(status({ executionStatus: 'dead_lettered', attempts: 5, lastError: 'boom' })).toBe(
      'failed',
    );
  });

  test('an execution status this build has never seen degrades to starting', () => {
    // One unknown enum value must not unmount a whole run report.
    expect(status({ executionStatus: 'some_future_status' })).toBe('starting');
  });
});

describe('craftRunStatus — outcome comes from the session, not the execution', () => {
  test('succeeded + a live session is running, not done', () => {
    for (const s of ['queued', 'branching', 'provisioning', 'running']) {
      expect(status({ sessionStatus: s, lastTurnEndReason: null })).toBe('running');
    }
  });

  test('a live session outranks a completed turn — a reuse session keeps working', () => {
    expect(status({ sessionStatus: 'running', lastTurnEndReason: 'completed' })).toBe('running');
  });

  test('terminal session + completed turn is done', () => {
    for (const s of ['stopped', 'failed', 'completed']) {
      expect(status({ sessionStatus: s, lastTurnEndReason: 'completed' })).toBe('done');
    }
  });

  test('a failed or vanished runtime is a failure', () => {
    expect(status({ lastTurnEndReason: 'failed' })).toBe('failed');
    expect(status({ lastTurnEndReason: 'runtime_gone' })).toBe('failed');
  });

  test('abandoned or unknown is stopped — neither invents a verdict', () => {
    expect(status({ lastTurnEndReason: 'abandoned' })).toBe('stopped');
    expect(status({ lastTurnEndReason: 'unknown' })).toBe('stopped');
  });

  test('a terminal session with NO ended turn is stopped', () => {
    // It stopped before finishing a turn. `failed` would invent a failure and
    // `done` would invent a result.
    expect(status({ sessionStatus: 'stopped', lastTurnEndReason: null })).toBe('stopped');
  });

  test('a deleted session leaves the run stopped, never failed', () => {
    // The FK is ON DELETE SET NULL: the run happened, we can no longer say how
    // it ended. Reporting `failed` would defame a craft whose session was
    // merely cleaned up.
    expect(status({ sessionStatus: null, lastTurnEndReason: null })).toBe('stopped');
  });

  test("session_status 'completed' is not read as success on its own", () => {
    // Nothing writes it in the live path, but if a backfilled row appears the
    // turn is still what decides.
    expect(status({ sessionStatus: 'completed', lastTurnEndReason: 'failed' })).toBe('failed');
  });
});

describe('craftRunIsSettled', () => {
  test('verdicts and skips are settled; dispatch states are not', () => {
    for (const s of ['done', 'failed', 'stopped', 'skipped'] as CraftRunStatus[]) {
      expect(craftRunIsSettled(s)).toBe(true);
    }
    for (const s of ['starting', 'retrying', 'running'] as CraftRunStatus[]) {
      expect(craftRunIsSettled(s)).toBe(false);
    }
  });
});

describe('craftRunStats', () => {
  const run = (s: CraftRunStatus, durationMs: number | null = null) => ({ status: s, durationMs });

  test('no runs yields no rate', () => {
    expect(craftRunStats([])).toEqual({
      total: 0,
      done: 0,
      failed: 0,
      successRate: null,
      avgDurationSeconds: null,
    });
  });

  test('the rate is done over settled VERDICTS only', () => {
    const stats = craftRunStats([run('done'), run('done'), run('done'), run('failed')]);
    expect(stats.successRate).toBe(75);
    expect(stats.total).toBe(4);
  });

  test('stopped and skipped are excluded from BOTH sides of the rate', () => {
    // A craft whose sandbox was reaped, or whose filter declined a delivery,
    // must not be reported as failing.
    const stats = craftRunStats([run('done'), run('stopped'), run('skipped'), run('starting')]);
    expect(stats.successRate).toBe(100);
    expect(stats.total).toBe(4);
    expect(stats.failed).toBe(0);
  });

  test('with no settled verdict the rate is null, not 0', () => {
    // 0% would read as "everything failed" for a craft that has only ever been
    // skipped or is still running.
    expect(craftRunStats([run('skipped'), run('running')]).successRate).toBeNull();
  });

  test('the average ignores runs with no duration', () => {
    const stats = craftRunStats([run('done', 2_000), run('done', 4_000), run('running', null)]);
    expect(stats.avgDurationSeconds).toBe(3);
  });

  test('a negative duration is ignored rather than skewing the mean', () => {
    const stats = craftRunStats([run('done', 6_000), run('done', -5_000)]);
    expect(stats.avgDurationSeconds).toBe(6);
  });

  test('the average rounds to whole seconds', () => {
    expect(craftRunStats([run('done', 1_400)]).avgDurationSeconds).toBe(1);
    expect(craftRunStats([run('done', 1_600)]).avgDurationSeconds).toBe(2);
  });
});

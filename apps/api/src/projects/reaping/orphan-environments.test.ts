/**
 * The environment reaper tie-in — the fast-follow `session-environment.ts`
 * records against itself.
 *
 * Scoping P2.4 found the "wide, mechanical" identity refactor the architecture
 * doc predicted was already done in P1.7: environments live in their own
 * `session_environments` table, `stopSessionEnvironment` is wired to session
 * stop and `deleteSessionEnvironment` to session delete, metering starts and
 * ends with the box, and the credential is deliberately the session's own.
 * What was NOT done is the sentence at `session-environment.ts`:
 * *"Environments have no session_sandboxes row, so the box reaper does not
 * manage them yet… Metering + reaper tie-in is the recorded fast-follow."*
 *
 * The gap is the session that gets neither stop nor delete — abandoned, or a
 * crash between the two. Its row survives every existing sweep: the DB-driven
 * reaper keys off `session_sandboxes` and never sees it, while the
 * provider-driven one holds every active environment row in its keepSet with no
 * age bound, so the row is what protects the box.
 */
import { describe, expect, test } from 'bun:test';
import {
  decideEnvironmentReaping,
  type EnvironmentReapCandidate,
} from './orphan-environments';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const base: EnvironmentReapCandidate = {
  sessionId: 's1',
  sessionDeletedAt: null,
  sessionMissing: false,
  lastUsedAt: ago(2 * DAY),
  workerStatus: 'running',
  workerUpdatedAt: ago(1 * HOUR),
  environmentStatus: 'active',
};

const decide = (c: Partial<EnvironmentReapCandidate>) =>
  decideEnvironmentReaping([{ ...base, ...c }], NOW);

describe('a session that is GONE — delete, nothing can want it back', () => {
  test('no session row at all', () => {
    expect(decide({ sessionMissing: true })).toEqual([
      { sessionId: 's1', action: 'delete', reason: 'session-missing' },
    ]);
  });

  test('soft-deleted past its own teardown window', () => {
    expect(decide({ sessionDeletedAt: ago(2 * HOUR) })).toEqual([
      { sessionId: 's1', action: 'delete', reason: 'session-deleted' },
    ]);
  });

  /**
   * `deleteSession` tears the environment down inline. Racing it would have two
   * paths deleting one provider box.
   */
  test('just deleted — left to the inline teardown', () => {
    expect(decide({ sessionDeletedAt: ago(30_000) })).toEqual([]);
  });
});

describe('a session that is LIVE — the horizon decides, and the two differ', () => {
  /**
   * THE case this design exists for. On pi.kortix.com 16 of 21 environments
   * were idle past a day while their sessions were perfectly alive. An
   * environment holds the session's WORKING TREE: committed work is safe on the
   * session branch in the git mirror, but uncommitted changes live only in that
   * box. Deleting on the short horizon would have destroyed sixteen live
   * sessions' uncommitted work — to reclaim compute the provider's own
   * `autoStopInterval: 60` had already stopped billing for.
   */
  test('idle a day: STOP, never delete — the working tree survives', () => {
    expect(decide({ lastUsedAt: ago(2 * DAY) })).toEqual([
      { sessionId: 's1', action: 'stop', reason: 'idle-stop' },
    ]);
  });

  test('idle a week: delete — a week of silence is evidence nobody is coming back', () => {
    expect(decide({ lastUsedAt: ago(8 * DAY) })).toEqual([
      { sessionId: 's1', action: 'delete', reason: 'idle-delete' },
    ]);
  });

  test('used within the hour: untouched', () => {
    expect(decide({ lastUsedAt: ago(1 * HOUR) })).toEqual([]);
  });

  test('the two horizons do not overlap at their boundary', () => {
    // Just inside a week is still a stop, not a delete.
    expect(decide({ lastUsedAt: ago(7 * DAY - HOUR) })[0]?.action).toBe('stop');
    expect(decide({ lastUsedAt: ago(7 * DAY + HOUR) })[0]?.action).toBe('delete');
  });
});

describe('the null case', () => {
  test('a never-used environment is unknown, not ancient', () => {
    // `lastUsedAt` is nullable. Read as epoch it would look a lifetime idle and
    // a box created seconds ago would be reaped.
    expect(decide({ lastUsedAt: null })).toEqual([]);
  });

  test('but a null lastUsedAt does not protect an environment whose session is gone', () => {
    expect(decide({ lastUsedAt: null, sessionMissing: true })[0]?.action).toBe('delete');
  });
});

test('mixed input: each row gets its own verdict', () => {
  const out = decideEnvironmentReaping(
    [
      { ...base, sessionId: 'fresh', lastUsedAt: ago(1 * HOUR) },
      { ...base, sessionId: 'idle', lastUsedAt: ago(2 * DAY) },
      { ...base, sessionId: 'ancient', lastUsedAt: ago(30 * DAY) },
      { ...base, sessionId: 'deleted', sessionDeletedAt: ago(5 * HOUR) },
      { ...base, sessionId: 'orphan', sessionMissing: true },
    ],
    NOW,
  );
  expect(out).toEqual([
    { sessionId: 'idle', action: 'stop', reason: 'idle-stop' },
    { sessionId: 'ancient', action: 'delete', reason: 'idle-delete' },
    { sessionId: 'deleted', action: 'delete', reason: 'session-deleted' },
    { sessionId: 'orphan', action: 'delete', reason: 'session-missing' },
  ]);
});

/**
 * The environment must not outlive the worker that was stopped.
 *
 * A 6-surface audit mapped THIRTEEN automatic paths that stop or remove a
 * session's worker box. `stopSessionEnvironment` is called from exactly two
 * places and BOTH are user-triggered (`stop.ts:129` and the explicit route).
 * Six of the thirteen bypass `applyStoppedState` entirely — there are really
 * two stop writers, `applyStoppedState` and `preserveEstablishedRuntime` — so
 * there is no choke point to hang the environment off. Hooking "the one stop
 * writer" would still miss the provider-removed, wake-fence, parked-runtime,
 * account-deletion and provision-race paths.
 *
 * So DERIVE it instead. Every path that durably parks a session writes
 * `project_sessions.status` in the same transaction, and this sweep already
 * joins that table. One rule covers all thirteen, and it cannot drift out of
 * sync with a stop path nobody remembered to update.
 *
 * Stop only — never delete. A stopped worker is an ordinary, resumable state.
 */
describe("the environment follows its worker's stop", () => {
  const workerStopped = (extra: Partial<EnvironmentReapCandidate> = {}) =>
    decideEnvironmentReaping(
      [{ ...base, lastUsedAt: ago(10 * 60_000), workerStatus: 'stopped', workerUpdatedAt: ago(HOUR), ...extra }],
      NOW,
    );

  test('a stopped worker stops the environment, even when it was just used', () => {
    // lastUsedAt is 10 minutes old — nowhere near the idle horizon. Without
    // this rule the environment would run on for up to 24h after its worker
    // was reaped, and the provider's own 60-minute auto-stop was the only
    // thing that ever powered it off.
    expect(workerStopped()).toEqual([
      { sessionId: 's1', action: 'stop', reason: 'worker-stopped' },
    ]);
  });

  test.each(['failed', 'completed'])('a %s worker also stops it', (status) => {
    expect(workerStopped({ workerStatus: status })[0]?.action).toBe('stop');
  });

  /**
   * The settle window is what keeps this off a restart. `restartSession` and
   * a wake both move the session out of a terminal status; acting inside the
   * window would stop the environment out from under a session coming back.
   */
  test('a worker stopped seconds ago is left alone', () => {
    expect(workerStopped({ workerUpdatedAt: ago(30_000) })).toEqual([]);
  });

  test.each(['running', 'queued', 'provisioning', 'branching'])(
    'a %s worker is not a stop signal',
    (status) => {
      expect(workerStopped({ workerStatus: status })).toEqual([]);
    },
  );

  test('an environment already stopped is not stopped again', () => {
    // Otherwise every tick issues a pointless provider call for every parked
    // session, forever.
    expect(workerStopped({ environmentStatus: 'stopped' })).toEqual([]);
  });

  /**
   * Evidence that the session is GONE still outranks evidence that it merely
   * stopped: delete beats stop.
   */
  test('a deleted session still deletes, not stops', () => {
    expect(workerStopped({ sessionDeletedAt: ago(2 * HOUR) })[0]).toEqual({
      sessionId: 's1',
      action: 'delete',
      reason: 'session-deleted',
    });
  });
});

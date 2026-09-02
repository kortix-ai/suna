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
import { selectReapableEnvironments, type EnvironmentReapCandidate } from './orphan-environments';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;

const base: EnvironmentReapCandidate = {
  sessionId: 's1',
  sessionDeletedAt: null,
  sessionMissing: false,
  lastUsedAt: ago(48 * HOUR),
};

describe('which environments are reapable', () => {
  test("a deleted session's environment is reapable", () => {
    const out = selectReapableEnvironments(
      [{ ...base, sessionDeletedAt: ago(2 * HOUR) }],
      NOW,
    );
    expect(out).toEqual(['s1']);
  });

  test('an environment whose session row is gone entirely is reapable', () => {
    expect(selectReapableEnvironments([{ ...base, sessionMissing: true }], NOW)).toEqual(['s1']);
  });

  /**
   * The abandoned case, and the reason this exists: a live session nobody has
   * touched in days still holds a box that only the provider's 60s idle timer
   * ever stopped, and that nothing ever deleted.
   */
  test('a live session idle past the horizon is reapable', () => {
    expect(selectReapableEnvironments([{ ...base, lastUsedAt: ago(48 * HOUR) }], NOW)).toEqual(['s1']);
  });

  test('a live session used recently is NOT reapable', () => {
    expect(selectReapableEnvironments([{ ...base, lastUsedAt: ago(1 * HOUR) }], NOW)).toEqual([]);
  });

  /**
   * A just-deleted session gets a grace window: teardown already ran
   * inline, and racing it would have two paths deleting one provider box.
   */
  test('a just-deleted session is left to its own teardown', () => {
    expect(
      selectReapableEnvironments([{ ...base, sessionDeletedAt: ago(30_000), lastUsedAt: ago(30_000) }], NOW),
    ).toEqual([]);
  });

  test('a never-used environment falls back to nothing, not to NaN', () => {
    // `lastUsedAt` is nullable in the schema. A null must not read as "epoch,
    // therefore ancient" on one branch and "unknown, therefore keep" on another.
    expect(selectReapableEnvironments([{ ...base, lastUsedAt: null }], NOW)).toEqual([]);
    expect(
      selectReapableEnvironments([{ ...base, lastUsedAt: null, sessionMissing: true }], NOW),
    ).toEqual(['s1']);
  });

  test('mixed input returns only the reapable ones', () => {
    const out = selectReapableEnvironments(
      [
        { ...base, sessionId: 'keep', lastUsedAt: ago(1 * HOUR) },
        { ...base, sessionId: 'idle', lastUsedAt: ago(72 * HOUR) },
        { ...base, sessionId: 'deleted', sessionDeletedAt: ago(5 * HOUR) },
        { ...base, sessionId: 'orphan', sessionMissing: true },
      ],
      NOW,
    );
    expect(out).toEqual(['idle', 'deleted', 'orphan']);
  });
});

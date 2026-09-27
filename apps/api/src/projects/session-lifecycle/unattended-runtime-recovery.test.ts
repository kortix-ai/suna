import { describe, expect, test } from 'bun:test';
import {
  MAX_RECOVERIES_PER_WINDOW,
  RECOVERY_MIN_GAP_MS,
  RECOVERY_WINDOW_MS,
  canAttemptRecovery,
  evaluateUnattendedRecovery,
  isUnattendedSession,
  pruneRecoveryAttempts,
  type RecoveryClaim,
  type UnattendedRecoveryDeps,
} from './unattended-runtime-recovery';

describe('isUnattendedSession', () => {
  test('a trigger/schedule/system origin is unattended', () => {
    expect(isUnattendedSession({ origin: 'trigger', metadata: null })).toBe(true);
    expect(isUnattendedSession({ origin: 'schedule', metadata: null })).toBe(true);
    expect(isUnattendedSession({ origin: 'system', metadata: null })).toBe(true);
  });

  test('a worker/sub-agent session is unattended even though its origin is `user`', () => {
    // session-origin.ts: an in-session token (the connector PAT a spawned
    // child session runs under) always resolves `user`, so origin alone
    // misses the majority of the census's deaths (7 of 8 were worker turns).
    expect(
      isUnattendedSession({ origin: 'user', metadata: { spawned_by_session: 'sess_parent' } }),
    ).toBe(true);
  });

  test('a human session, or a KaaB backend session, is attended', () => {
    expect(isUnattendedSession({ origin: 'user', metadata: null })).toBe(false);
    expect(isUnattendedSession({ origin: 'backend', metadata: null })).toBe(false);
  });

  test('a non-string spawned_by_session (bad data) is not unattended', () => {
    expect(isUnattendedSession({ origin: 'user', metadata: { spawned_by_session: 42 } })).toBe(false);
    expect(isUnattendedSession({ origin: 'user', metadata: { spawned_by_session: '' } })).toBe(false);
  });
});

describe('pruneRecoveryAttempts / canAttemptRecovery — the bound is 2/hour with a 30s gap', () => {
  test('an empty history always allows the first attempt', () => {
    expect(canAttemptRecovery([], 1_000_000)).toBe(true);
  });

  test('a second attempt inside the min gap is refused', () => {
    const now = 1_000_000;
    expect(canAttemptRecovery([now - RECOVERY_MIN_GAP_MS + 1], now)).toBe(false);
    expect(canAttemptRecovery([now - RECOVERY_MIN_GAP_MS], now)).toBe(true);
  });

  test(`the ${MAX_RECOVERIES_PER_WINDOW}rd attempt inside the rolling window is refused`, () => {
    const now = 1_000_000;
    const attempts = [now - RECOVERY_WINDOW_MS / 2, now - RECOVERY_MIN_GAP_MS];
    expect(attempts).toHaveLength(MAX_RECOVERIES_PER_WINDOW);
    expect(canAttemptRecovery(attempts, now)).toBe(false);
  });

  test('an attempt older than the window is pruned, freeing the budget', () => {
    const now = 1_000_000;
    const stale = now - RECOVERY_WINDOW_MS - 1;
    expect(pruneRecoveryAttempts([stale], now)).toEqual([]);
    expect(canAttemptRecovery([stale, now - RECOVERY_MIN_GAP_MS], now)).toBe(true);
  });

  test('a clock that runs backward (a future-dated attempt) is dropped, not trusted', () => {
    const now = 1_000_000;
    expect(pruneRecoveryAttempts([now + 5_000], now)).toEqual([]);
  });
});

function deps(claim: RecoveryClaim | 'throw', overrides: Partial<UnattendedRecoveryDeps> = {}) {
  const calls: Array<{ sandboxId: string; nowMs?: number }> = [];
  const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const d: UnattendedRecoveryDeps = {
    claim: async (sandboxId, nowMs) => {
      calls.push({ sandboxId, nowMs });
      if (claim === 'throw') throw new Error('row lock timeout');
      return claim;
    },
    log: (message, meta) => logs.push({ message, meta }),
    ...overrides,
  };
  return { d, calls, logs };
}

describe('evaluateUnattendedRecovery — orchestration', () => {
  test('an attended session never even asks for a claim', async () => {
    const { d, calls } = deps('claimed');
    const outcome = await evaluateUnattendedRecovery(
      { sandboxId: 'sb-1', session: { origin: 'user', metadata: null } },
      d,
    );
    expect(outcome).toBe('skipped_attended');
    expect(calls).toHaveLength(0);
  });

  test('an unattended session with budget left is claimed', async () => {
    const { d, calls } = deps('claimed');
    const outcome = await evaluateUnattendedRecovery(
      { sandboxId: 'sb-1', session: { origin: 'trigger', metadata: null }, now: 42 },
      d,
    );
    expect(outcome).toBe('claimed');
    expect(calls).toEqual([{ sandboxId: 'sb-1', nowMs: 42 }]);
  });

  test('a bounded claim leaves the prompt held and logs why', async () => {
    const { d, logs } = deps('bounded');
    const outcome = await evaluateUnattendedRecovery(
      { sandboxId: 'sb-1', session: { origin: 'schedule', metadata: null } },
      d,
    );
    expect(outcome).toBe('skipped_bounded');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toContain('bounded');
  });

  test('a claim failure (e.g. a DB error) fails CLOSED to the held default, never throws', async () => {
    const { d, logs } = deps('throw');
    const outcome = await evaluateUnattendedRecovery(
      { sandboxId: 'sb-1', session: { origin: 'system', metadata: null } },
      d,
    );
    expect(outcome).toBe('error');
    expect(logs[0]?.meta.error).toContain('row lock timeout');
  });
});

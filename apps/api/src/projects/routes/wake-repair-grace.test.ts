/**
 * A wake timeout must not park a session whose repair is still running.
 *
 * `staleOpencodeReadyReason` learned this in #7954. It was only half the rule:
 * that guard sits on the OpenCode readiness clock, and a session open has a
 * SECOND clock that parks — the runtime wake fence, budgeted at
 * `RUNTIME_WAKE_GRACE_MS` (90s). A legacy-runtime repair is budgeted at
 * `LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS` (8 min). So the wake fence parks every
 * repair that needs more than 90 seconds, and the platform spends 8 minutes
 * fixing a box it has already told the user is `failed`.
 *
 * Measured on dev, session 8e3d6a63, 2026-09-28:
 *   08:17:58.513  legacyRuntimeBootstrap.lastAttemptAt   (state 'running')
 *   08:20:15.322  runtimeStartFailedAt, stopReason 'runtime_wake_failed',
 *                 runtimeParkReason 'runtime_status_unknown_timeout'
 *   08:26:08.293  legacyRuntimeBootstrap.finishedAt
 * The park landed 2m17s into an 8-minute repair that was still running.
 */

import { describe, expect, test } from 'bun:test';

import { staleRuntimeWakeReason } from './shared';

const WAKE_GRACE_MS = 90_000;
const NOW = Date.parse('2026-09-28T08:20:15.322Z');

function row(metadata: Record<string, unknown>) {
  return {
    status: 'active',
    externalId: 'sbx_test',
    updatedAt: new Date(NOW),
    metadata,
  } as never;
}

/** The wake clock is already past its 90s grace in every case below. */
const expiredWakeClock = {
  runtimeWakeStartedAt: new Date(NOW - WAKE_GRACE_MS - 60_000).toISOString(),
};

describe('the wake fence and an in-flight repair', () => {
  test('parks when no repair is running', () => {
    expect(staleRuntimeWakeReason(row({ ...expiredWakeClock }), 'unknown', NOW)).toBe(
      'runtime_status_unknown_timeout',
    );
  });

  test('parks a stopped box with no repair running', () => {
    expect(staleRuntimeWakeReason(row({ ...expiredWakeClock }), 'stopped', NOW)).toBe(
      'runtime_wake_timeout',
    );
  });

  test('does NOT park while a repair is running inside its budget', () => {
    // The exact shape measured on 8e3d6a63.
    expect(
      staleRuntimeWakeReason(
        row({
          ...expiredWakeClock,
          legacyRuntimeBootstrap: {
            state: 'running',
            lastAttemptAt: '2026-09-28T08:17:58.513Z',
            reason: 'session-open',
          },
        }),
        'unknown',
        NOW,
      ),
    ).toBeNull();
  });

  test('does NOT park a stopped box while a repair is running', () => {
    expect(
      staleRuntimeWakeReason(
        row({
          ...expiredWakeClock,
          legacyRuntimeBootstrap: {
            state: 'running',
            lastAttemptAt: new Date(NOW - 60_000).toISOString(),
          },
        }),
        'stopped',
        NOW,
      ),
    ).toBeNull();
  });

  test('parks again once the repair has run past its own budget', () => {
    // A repair that never reports a terminal state must not hold the session
    // open forever: the grace is bounded by the repair budget, not by the
    // record existing.
    expect(
      staleRuntimeWakeReason(
        row({
          ...expiredWakeClock,
          legacyRuntimeBootstrap: {
            state: 'running',
            lastAttemptAt: new Date(NOW - 9 * 60_000).toISOString(),
          },
        }),
        'unknown',
        NOW,
      ),
    ).toBe('runtime_status_unknown_timeout');
  });

  test('parks when the repair already finished', () => {
    expect(
      staleRuntimeWakeReason(
        row({
          ...expiredWakeClock,
          legacyRuntimeBootstrap: {
            state: 'failed',
            lastAttemptAt: new Date(NOW - 60_000).toISOString(),
          },
        }),
        'unknown',
        NOW,
      ),
    ).toBe('runtime_status_unknown_timeout');
  });

  test('a running provider is never parked by this fence', () => {
    expect(staleRuntimeWakeReason(row({ ...expiredWakeClock }), 'running', NOW)).toBeNull();
  });
});

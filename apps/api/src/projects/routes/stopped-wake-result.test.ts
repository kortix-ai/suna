/**
 * `/start` must never replay a stamped failure as a terminal answer.
 *
 * Essentia 2026-08-26, two live captures:
 *   - session e06ad0c4 answered `open-session:failed` in 47ms — no provider
 *     call — because a wake that ran out of its FIXED 240s budget had stamped
 *     `runtime_wake_failed`. The manual restart reached ready in 10s.
 *   - session 9c8749ac / box i67m4fhw2t3nesssgl4yf replayed
 *     `{"stage":"failed","retriable":false,…"stopReason":"runtime_boot_failed",
 *       "lastInitError":null}` on every open for 10+ hours from a 03:37Z stamp.
 *
 * Both stop reasons are covered here. The contract this file pins:
 *   1. a stamped failure suppresses re-attempts for a COOLDOWN, never for ever;
 *   2. past the cooldown the projection returns `null`, which is what makes the
 *      caller fall through and RE-ATTEMPT the wake;
 *   3. nothing that can still be re-attempted carries `retriable: false`;
 *   4. every negative names the check that produced it.
 */

import type { sessionSandboxes } from '@kortix/db';
import { describe, expect, test } from 'bun:test';
import { stoppedWakeResult } from './shared';

const FAILED_AT = new Date('2026-08-26T03:37:09.000Z');
const at = (ms: number) => new Date(FAILED_AT.getTime() + ms);

function stoppedRow(
  metadata: Record<string, unknown>,
): typeof sessionSandboxes.$inferSelect {
  return {
    sandboxId: 'sess-9c8749ac',
    sessionId: 'sess-9c8749ac',
    projectId: 'proj-e7170bf8',
    accountId: 'acct-1',
    provider: 'e2b',
    externalId: 'i67m4fhw2t3nesssgl4yf',
    baseUrl: null,
    status: 'stopped',
    config: {},
    metadata,
    lastUsedAt: null,
    deadlineAt: null,
    createdAt: FAILED_AT,
    updatedAt: FAILED_AT,
  } as unknown as typeof sessionSandboxes.$inferSelect;
}

/** The exact metadata from the 2026-08-26 DevTools capture. */
const CAPTURED = {
  stopReason: 'runtime_boot_failed',
  initStatus: 'ready',
  healthStatus: 'unknown',
  initAttempts: 1,
  initMaxAttempts: 3,
  lastInitError: null,
  stoppedAt: FAILED_AT.toISOString(),
  lifecycle: 'pause-filesystem-explicit-resume',
  warm: true,
};

describe('stoppedWakeResult — a stamped failure is a cooldown, not a dead end', () => {
  test('THE REGRESSION: the captured 10-hour replay now falls through to a re-attempt', () => {
    // Old behaviour: `stage:"failed", retriable:false` — for ever.
    expect(stoppedWakeResult(stoppedRow(CAPTURED), 'default', null, at(10 * 3_600_000))).toBeNull();
  });

  test('inside the cooldown it says starting + retriable, never failed', () => {
    const result = stoppedWakeResult(stoppedRow(CAPTURED), 'default', null, at(30_000));
    expect(result?.stage).toBe('starting');
    expect(result?.retriable).toBe(true);
    expect(result?.reason).toBe('runtime_wake_cooldown');
    expect(result?.failure?.retryable).toBe(true);
  });

  test('past the cooldown the next /start re-attempts (null = fall through)', () => {
    expect(stoppedWakeResult(stoppedRow(CAPTURED), 'default', null, at(121_000))).toBeNull();
  });

  test('covers the wake-failed variant identically', () => {
    const wakeFailed = {
      stopReason: 'runtime_wake_failed',
      runtimeWakeError: 'provider_not_running',
      runtimeWakeFailedAt: FAILED_AT.toISOString(),
      runtimeStartFailedAt: FAILED_AT.toISOString(),
      runtimeStartFailureCount: 1,
      runtimeStartRetryAfterAt: at(120_000).toISOString(),
    };
    expect(stoppedWakeResult(stoppedRow(wakeFailed), 'default', null, at(60_000))?.stage).toBe(
      'starting',
    );
    expect(stoppedWakeResult(stoppedRow(wakeFailed), 'default', null, at(121_000))).toBeNull();
  });

  test('a negative always names the check that produced it', () => {
    const wakeFailed = {
      stopReason: 'runtime_wake_failed',
      runtimeWakeError: 'start_timeout',
      runtimeStartFailedAt: FAILED_AT.toISOString(),
      runtimeStartFailureCount: 2,
      runtimeStartRetryAfterAt: at(300_000).toISOString(),
    };
    const result = stoppedWakeResult(stoppedRow(wakeFailed), 'default', null, at(60_000));
    expect(result?.failure?.evidence).toEqual({
      check: 'start_timeout',
      observed_at: FAILED_AT.toISOString(),
      error: null,
      attempts: 2,
      next_retry_at: at(300_000).toISOString(),
    });
    // …and the message counts the attempts instead of ordering a manual restart.
    expect(result?.failure?.message).toContain('attempt 2');
  });

  test('the attempt budget earns a terminal card — which itself expires', () => {
    const spent = {
      stopReason: 'runtime_wake_failed',
      runtimeWakeError: 'provider_not_running',
      runtimeStartFailedAt: FAILED_AT.toISOString(),
      runtimeStartFailureCount: 5,
      runtimeStartRetryAfterAt: FAILED_AT.toISOString(),
    };
    const terminal = stoppedWakeResult(stoppedRow(spent), 'default', null, at(60_000));
    expect(terminal?.stage).toBe('failed');
    expect(terminal?.failure?.evidence?.attempts).toBe(5);
    expect(terminal?.failure?.message).toContain('5 attempts');
    // 30 minutes on, the verdict is no longer evidence about now.
    expect(stoppedWakeResult(stoppedRow(spent), 'default', null, at(31 * 60_000))).toBeNull();
  });

  test('a live wake still coalesces behind its claim, before any cooldown logic', () => {
    const waking = {
      ...CAPTURED,
      runtimeWakeId: 'wake-2',
      runtimeWakeStartedAt: at(200_000).toISOString(),
      runtimeWakeLeaseExpiresAt: at(440_000).toISOString(),
    };
    const result = stoppedWakeResult(stoppedRow(waking), 'default', null, at(210_000));
    expect(result?.stage).toBe('starting');
    expect(result?.reason).toBe('runtime_waking');
  });

  test('a preserved-unavailable identity still outranks every wake clock', () => {
    const unavailable = { ...CAPTURED, runtimeIdentityState: 'unavailable' };
    expect(stoppedWakeResult(stoppedRow(unavailable), 'default', null, at(30_000))).toBeNull();
  });

  test('an ordinary idle stop is not a stamped failure', () => {
    expect(
      stoppedWakeResult(
        stoppedRow({ stopReason: 'idle', stoppedAt: FAILED_AT.toISOString() }),
        'default',
        null,
        at(1_000),
      ),
    ).toBeNull();
  });

  test('a row that is not stopped is never this projection', () => {
    const active = { ...stoppedRow(CAPTURED), status: 'active' as const };
    expect(stoppedWakeResult(active, 'default', null, at(1_000))).toBeNull();
  });
});

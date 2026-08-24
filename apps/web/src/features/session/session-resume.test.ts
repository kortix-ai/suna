import { describe, expect, test } from 'bun:test';

import {
  AUTO_RESUME_WINDOW_MS,
  isAutoResuming,
  isRuntimeIdentityUnavailable,
  isSandboxResumable,
} from './session-resume';

describe('isSandboxResumable', () => {
  test('stopped + external_id → resumable (the hibernated-box case)', () => {
    expect(isSandboxResumable({ status: 'stopped', external_id: 'sbx_1' })).toBe(true);
  });

  test('stopped with NO external_id → not resumable (genuinely gone)', () => {
    expect(isSandboxResumable({ status: 'stopped', external_id: null })).toBe(false);
    expect(isSandboxResumable({ status: 'stopped' })).toBe(false);
  });

  test('non-stopped statuses are never "resumable" here', () => {
    expect(isSandboxResumable({ status: 'error', external_id: 'sbx_1' })).toBe(false);
    expect(isSandboxResumable({ status: 'active', external_id: 'sbx_1' })).toBe(false);
  });

  test('null / undefined sandbox → not resumable', () => {
    expect(isSandboxResumable(null)).toBe(false);
    expect(isSandboxResumable(undefined)).toBe(false);
  });
});

/**
 * The budget is TIME, not attempts.
 *
 * It used to be three attempts spaced 1500ms — `0ms, 1500ms, 1500ms`, so about
 * THREE SECONDS in total. A sandbox resume does not fit in three seconds:
 * measured end to end on dev, `/start` alone answers in ~1.9s and the runtime
 * becomes reachable ~3s after that. So a perfectly healthy box that was merely
 * asleep ran out of budget mid-wake, and the page replaced its loader with the
 * dead-end card "session <id> is stopped — open a new session to continue"…
 * moments before the box came up and the session loaded fine.
 *
 * Reported exactly that way (essentia, 2026-08-24): "ALL OF THEM WILL SHOW ME
 * THE ERROR AFTER TRYING TO CONNECT FOR A WHILE & THEN THEY WILL CONNECT".
 *
 * A count cannot express "how long is it reasonable to wait for a machine to
 * boot". A deadline can.
 */
describe('isAutoResuming', () => {
  const box = { status: 'stopped', external_id: 'sbx_1' };

  test('inside the window a resumable box is waking, however many attempts it took', () => {
    expect(isAutoResuming(box, { elapsedMs: 0 })).toBe(true);
    expect(isAutoResuming(box, { elapsedMs: 3_000 })).toBe(true);
    // The old budget gave up here. A real resume is only just finishing.
    expect(isAutoResuming(box, { elapsedMs: 20_000 })).toBe(true);
  });

  test('past the window it stops waking and offers Restart', () => {
    expect(isAutoResuming(box, { elapsedMs: AUTO_RESUME_WINDOW_MS })).toBe(false);
    expect(isAutoResuming(box, { elapsedMs: AUTO_RESUME_WINDOW_MS + 1 })).toBe(false);
  });

  test('the window is long enough for a real resume', () => {
    // /start ~1.9s + runtime reachable ~3s, measured on dev 2026-08-24, and a
    // loaded or image-heavy box is slower still.
    expect(AUTO_RESUME_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
  });

  test('not resumable → never auto-resuming, however early', () => {
    expect(isAutoResuming({ status: 'error', external_id: 'sbx_1' }, { elapsedMs: 0 })).toBe(false);
    expect(isAutoResuming({ status: 'stopped', external_id: null }, { elapsedMs: 0 })).toBe(false);
  });

  test('a caller with no clock yet is treated as just-started, not as expired', () => {
    expect(isAutoResuming(box, { elapsedMs: null })).toBe(true);
  });
});

// Regression for prod session ad4b63ac (2026-08-13). Its Platinum box was lost
// provider-side; the server answered `/start` with `stage: 'failed'`,
// `retriable: false`, `reason: 'runtime_identity_unavailable'` — and a
// SERIALIZED sandbox row that still reads `status: 'stopped'` + an
// `external_id`, because preserving the identity is the whole point of that
// path. `isSandboxResumable` saw only those two fields and said "resumable", so
// the page burned 3 auto-resume `/start` round trips against a runtime the
// server had already declared permanently gone, then showed the generic
// "is stopped — Restart session" card. Every restart from there 409s.
describe('isSandboxResumable — a preserved-unavailable identity is never resumable', () => {
  test('stopped + external_id but runtimeIdentityState "unavailable" → not resumable', () => {
    expect(
      isSandboxResumable({
        status: 'stopped',
        external_id: 'sbx_01KZP370WDB8DGYNAQM1B875VR',
        metadata: {
          runtimeIdentityState: 'unavailable',
          preservedExternalId: 'sbx_01KZP370WDB8DGYNAQM1B875VR',
          runtimeUnavailableReason: 'runtime_removed',
        },
      }),
    ).toBe(false);
  });

  test('an in-flight same-id restore is still resumable — only "unavailable" is terminal', () => {
    for (const state of ['recovering', 'recovery_claimed', 'recovered']) {
      expect(
        isSandboxResumable({
          status: 'stopped',
          external_id: 'sbx_1',
          metadata: { runtimeIdentityState: state },
        }),
      ).toBe(true);
    }
  });

  test('an ordinary parked box (no identity state) stays resumable', () => {
    expect(
      isSandboxResumable({ status: 'stopped', external_id: 'sbx_1', metadata: {} }),
    ).toBe(true);
  });

  test('auto-resume never fires against an unavailable identity', () => {
    expect(
      isAutoResuming(
        {
          status: 'stopped',
          external_id: 'sbx_1',
          metadata: { runtimeIdentityState: 'unavailable' },
        },
        { elapsedMs: 0 },
      ),
    ).toBe(false);
  });
});

describe('isRuntimeIdentityUnavailable', () => {
  test('true only for a preserved-unavailable row', () => {
    expect(
      isRuntimeIdentityUnavailable({
        status: 'stopped',
        external_id: 'sbx_1',
        metadata: { runtimeIdentityState: 'unavailable' },
      }),
    ).toBe(true);
  });

  test('false for a parked box, a recovering box, and no sandbox at all', () => {
    expect(isRuntimeIdentityUnavailable({ status: 'stopped', external_id: 'sbx_1' })).toBe(false);
    expect(
      isRuntimeIdentityUnavailable({
        status: 'stopped',
        external_id: 'sbx_1',
        metadata: { runtimeIdentityState: 'recovering' },
      }),
    ).toBe(false);
    expect(isRuntimeIdentityUnavailable(null)).toBe(false);
    expect(isRuntimeIdentityUnavailable(undefined)).toBe(false);
  });

  test('a non-object metadata value cannot throw', () => {
    expect(
      isRuntimeIdentityUnavailable({
        status: 'stopped',
        external_id: 'sbx_1',
        metadata: null as unknown as Record<string, unknown>,
      }),
    ).toBe(false);
  });
});

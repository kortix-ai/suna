import { describe, expect, test } from 'bun:test';

import {
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

describe('isAutoResuming', () => {
  const box = { status: 'stopped', external_id: 'sbx_1' };

  test('resumable + attempts under the cap → still waking (show loader)', () => {
    expect(isAutoResuming(box, 0, 3)).toBe(true);
    expect(isAutoResuming(box, 2, 3)).toBe(true);
  });

  test('resumable but attempts exhausted → stop auto-waking (fall through to Restart)', () => {
    expect(isAutoResuming(box, 3, 3)).toBe(false);
    expect(isAutoResuming(box, 4, 3)).toBe(false);
  });

  test('not resumable → never auto-resuming regardless of attempts', () => {
    expect(isAutoResuming({ status: 'error', external_id: 'sbx_1' }, 0, 3)).toBe(false);
    expect(isAutoResuming({ status: 'stopped', external_id: null }, 0, 3)).toBe(false);
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
        0,
        3,
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

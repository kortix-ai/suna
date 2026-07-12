import { describe, expect, test } from 'bun:test';

import { isAutoResuming, isSandboxResumable } from './session-resume';

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

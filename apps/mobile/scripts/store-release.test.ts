import { describe, expect, test } from 'bun:test';

import { compareVersions, iosStep } from './store-release.mjs';

describe('store release decisions', () => {
  test('compares versions numerically, not as text', () => {
    expect(compareVersions('1.5.10', '1.5.9')).toBe(1);
    expect(compareVersions('1.5.5', '1.5.5')).toBe(0);
    expect(compareVersions('1.4.9', '1.5.0')).toBe(-1);
  });

  test('submits only a version nobody has sent to Apple', () => {
    expect(iosStep('PREPARE_FOR_SUBMISSION')).toBe('submit');
    expect(iosStep('READY_FOR_REVIEW')).toBe('submit');
  });

  test('never resubmits what Apple rejected or a person pulled from review', () => {
    for (const state of ['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'DEVELOPER_REJECTED']) {
      expect(iosStep(state)).toBe('blocked');
    }
  });

  test('releases an approved version held for a manual release', () => {
    expect(iosStep('PENDING_DEVELOPER_RELEASE')).toBe('release');
  });

  test('leaves a version alone while Apple has it or after it is live', () => {
    for (const state of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION']) {
      expect(iosStep(state)).toBe('wait');
    }
    expect(iosStep('READY_FOR_DISTRIBUTION')).toBe('live');
    expect(iosStep('READY_FOR_SALE')).toBe('live');
  });
});

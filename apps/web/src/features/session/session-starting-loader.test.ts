import { describe, expect, test } from 'bun:test';

import { sessionBootStep } from './session-starting-loader';

describe('sessionBootStep', () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['runtime_waking', 0],
    ['runtime_status_unknown', 0],
    ['runtime_restoring_in_place', 1],
    ['runtime_recovery_in_progress', 1],
    ['runtime_recovered_in_place', 2],
    ['acp_starting', 2],
    ['acp_boot_error', 2],
    ['acp_ready', 3],
  ];

  for (const [reason, expectedStep] of cases) {
    test(`maps ${reason} to visible step ${expectedStep}`, () => {
      expect(sessionBootStep('starting', reason)).toBe(expectedStep);
    });
  }

  test('uses the coarse stage when the API has no known reason', () => {
    expect(sessionBootStep('provisioning', null)).toBe(0);
    expect(sessionBootStep('starting', null)).toBe(1);
    expect(sessionBootStep('ready', null)).toBe(3);
    expect(sessionBootStep('starting', 'future_reason')).toBe(1);
  });
});

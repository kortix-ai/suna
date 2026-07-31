import { describe, expect, test } from 'bun:test';

import {
  isDormantSessionWithoutRuntime,
  isUnmaterializedSessionFailure,
} from './session-terminal-state';

const base = {
  stage: 'failed' as const,
  retriable: false,
  hasStartError: false,
  sandboxStatus: null as string | null,
};

describe('isUnmaterializedSessionFailure', () => {
  test('detects a terminal failed stage with no sandbox payload', () => {
    expect(isUnmaterializedSessionFailure(base)).toBe(true);
  });

  test('does not replace a typed start error', () => {
    expect(isUnmaterializedSessionFailure({ ...base, hasStartError: true })).toBe(false);
  });

  test('defers sandbox terminal states to their detailed error card', () => {
    for (const sandboxStatus of ['error', 'stopped']) {
      expect(isUnmaterializedSessionFailure({ ...base, sandboxStatus })).toBe(false);
    }
  });

  test('does not claim that an active sandbox was never created', () => {
    expect(isUnmaterializedSessionFailure({ ...base, sandboxStatus: 'active' })).toBe(false);
  });

  // The reported bug: a session that has not started yet was rendered as a hard
  // provisioning failure. Every non-terminal stage must read as pending, even
  // though useSession reports `phase: 'error'` for a transient runtime error.
  test('a session that is still provisioning is pending, never failed', () => {
    for (const stage of [null, 'provisioning', 'starting', 'ready'] as const) {
      expect(isUnmaterializedSessionFailure({ ...base, stage })).toBe(false);
    }
  });

  test('a retriable start result is pending even at an unexpected stage', () => {
    expect(isUnmaterializedSessionFailure({ ...base, retriable: true })).toBe(false);
  });

  test('a stopped session is not a provisioning failure', () => {
    expect(isUnmaterializedSessionFailure({ ...base, stage: 'stopped' })).toBe(false);
  });
});

describe('isDormantSessionWithoutRuntime', () => {
  test('detects a stopped stage with no sandbox payload', () => {
    expect(isDormantSessionWithoutRuntime({ ...base, stage: 'stopped' })).toBe(true);
  });

  test('never overlaps the provisioning-failure card', () => {
    expect(isDormantSessionWithoutRuntime(base)).toBe(false);
    expect(isUnmaterializedSessionFailure({ ...base, stage: 'stopped' })).toBe(false);
  });

  test('stays quiet while the boot is still retriable', () => {
    expect(isDormantSessionWithoutRuntime({ ...base, stage: 'stopped', retriable: true })).toBe(
      false,
    );
  });

  test('defers to the sandbox-row card when a row was serialized', () => {
    expect(
      isDormantSessionWithoutRuntime({ ...base, stage: 'stopped', sandboxStatus: 'stopped' }),
    ).toBe(false);
  });

  test('does not replace a typed start error', () => {
    expect(
      isDormantSessionWithoutRuntime({ ...base, stage: 'stopped', hasStartError: true }),
    ).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';

import {
  type BootInput,
  SLOW_BOOT_MS,
  STARTING_SUBSTEP_MS,
  bootStatus,
  wakeCooldownNote,
} from './boot-status.ts';

function input(overrides: Partial<BootInput> = {}): BootInput {
  return {
    phase: 'starting',
    stage: 'starting',
    reason: null,
    failure: null,
    msInStage: 0,
    msTotal: 0,
    now: 1_000_000,
    ...overrides,
  };
}

describe('bootStatus', () => {
  test('null once ready or failed — those states have their own readouts', () => {
    expect(bootStatus(input({ phase: 'ready', stage: 'ready' }))).toBeNull();
    expect(bootStatus(input({ phase: 'error', stage: 'failed' }))).toBeNull();
  });

  test('narrates the stages with the web app’s labels', () => {
    expect(bootStatus(input({ stage: 'provisioning' }))?.label).toBe('Reserving your computer');
    expect(bootStatus(input({ stage: 'starting', msInStage: 0 }))?.label).toBe(
      'Loading your workspace',
    );
    expect(bootStatus(input({ stage: 'starting', msInStage: STARTING_SUBSTEP_MS }))?.label).toBe(
      'Waking the agent',
    );
    expect(bootStatus(input({ stage: 'stopped' }))?.label).toBe('Waking your parked computer');
    // `stage === 'ready'` but not yet switched: the runtime is being wired in.
    expect(bootStatus(input({ stage: 'ready' }))?.label).toBe('Connecting');
    expect(bootStatus(input({ stage: null }))?.label).toBe('Starting');
  });

  test('a slow boot says so instead of spinning silently', () => {
    expect(bootStatus(input({ msTotal: SLOW_BOOT_MS - 1 }))?.note).toBeNull();
    expect(bootStatus(input({ msTotal: SLOW_BOOT_MS }))?.note).toContain(
      'Taking longer than usual',
    );
  });

  test('a wake cooldown keeps the provider failure and the retry clock visible', () => {
    const status = bootStatus(
      input({
        reason: 'runtime_wake_cooldown',
        failure: {
          evidence: { attempts: 2, next_retry_at: new Date(1_000_000 + 90_000).toISOString() },
        },
        msTotal: SLOW_BOOT_MS + 1,
      }),
    );
    expect(status?.note).toBe('Computer did not start. Retrying in 1m 30s (attempt 3).');
  });
});

describe('wakeCooldownNote', () => {
  test('null unless the reason is a wake cooldown with a failure', () => {
    expect(wakeCooldownNote({ reason: 'runtime_waking', failure: null, now: 0 })).toBeNull();
    expect(wakeCooldownNote({ reason: 'runtime_wake_cooldown', failure: null, now: 0 })).toBeNull();
  });

  test('no retry timestamp still names the attempt', () => {
    expect(wakeCooldownNote({ reason: 'runtime_wake_cooldown', failure: {}, now: 0 })).toBe(
      'Computer did not start. Retrying automatically (attempt 2).',
    );
  });

  test('a retry moment in the past reads as now', () => {
    expect(
      wakeCooldownNote({
        reason: 'runtime_wake_cooldown',
        failure: { evidence: { attempts: 1, next_retry_at: new Date(0).toISOString() } },
        now: 5_000,
      }),
    ).toBe('Computer did not start. Retrying now (attempt 2).');
  });
});

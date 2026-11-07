import { describe, expect, test } from 'bun:test';

import {
  type BootInput,
  SLOW_BOOT_MS,
  STARTING_SUBSTEP_MS,
  bootStatus,
  formatStepElapsed,
  imageStepLabel,
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

describe('bootStatus with an image step', () => {
  const NOW = Date.parse('2030-01-01T00:10:00.000Z');
  /** A step that began 42 s before NOW. */
  const step = (state: string) =>
    ({ state, image: 'kortix-template-v7', since: new Date(NOW - 42_000).toISOString() }) as never;
  const provisioning = (image: unknown, overrides: Partial<BootInput> = {}) =>
    bootStatus(input({ stage: 'provisioning', image: image as BootInput['image'], now: NOW, ...overrides }));

  test('every image state reads in the CLI’s words with its m:ss clock', () => {
    const cases: Array<[string, string]> = [
      ['resolving', 'Choosing the image (0:42)'],
      ['serving_last_ready', 'Starting from the last ready image while the new one builds (0:42)'],
      ['waiting_for_build', 'Waiting for the first image for this workspace to finish building (0:42)'],
      ['building', 'Building the first image for this workspace (0:42)'],
      ['copying_to_region', "Copying the image to the session's region (0:42)"],
      ['waiting_for_provider', 'Waiting for the provider to finish the image (retrying, 0:42)'],
    ];
    for (const [state, label] of cases) {
      expect(provisioning(step(state))).toEqual({ label, note: null, timed: true });
    }
  });

  test('no image step keeps today’s text and the caller’s clock', () => {
    const today = { label: 'Reserving your computer', note: null, timed: false };
    expect(provisioning(null)).toEqual(today);
    expect(provisioning(undefined)).toEqual(today);
  });

  test('an image step outside provisioning is ignored', () => {
    expect(provisioning(step('building'), { stage: 'starting' })).toEqual({
      label: 'Loading your workspace',
      note: null,
      timed: false,
    });
  });

  test('a long image build does not say the sandbox may be wedged', () => {
    expect(provisioning(step('building'), { msTotal: SLOW_BOOT_MS * 10 })?.note).toBeNull();
    expect(provisioning(null, { msTotal: SLOW_BOOT_MS })?.note).toContain('may be wedged');
  });

  test('a wake cooldown note still shows under an image step', () => {
    expect(
      provisioning(step('building'), {
        reason: 'runtime_wake_cooldown',
        failure: { evidence: { attempts: 1, next_retry_at: null } },
      }),
    ).toEqual({
      label: 'Building the first image for this workspace (0:42)',
      note: 'Computer did not start. Retrying automatically (attempt 2).',
      timed: true,
    });
  });
});

describe('imageStepLabel', () => {
  test('a state a newer API adds reads humanized in sentence case', () => {
    expect(imageStepLabel({ state: 'warming_cache' as never, image: null, since: '' }, 0)).toBe(
      'Warming cache',
    );
  });

  test('an unparseable since drops the clock; a since ahead of the local clock reads 0:00', () => {
    expect(imageStepLabel({ state: 'building', image: null, since: 'nope' }, 0)).toBe(
      'Building the first image for this workspace',
    );
    expect(
      imageStepLabel({ state: 'resolving', image: null, since: new Date(5_000).toISOString() }, 0),
    ).toBe('Choosing the image (0:00)');
  });

  test('formatStepElapsed is m:ss, then h:mm:ss', () => {
    expect(formatStepElapsed(0)).toBe('0:00');
    expect(formatStepElapsed(42_999)).toBe('0:42');
    expect(formatStepElapsed(12 * 60_000 + 5_000)).toBe('12:05');
    expect(formatStepElapsed(3_723_000)).toBe('1:02:03');
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

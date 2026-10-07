import { describe, expect, test } from 'bun:test';
import {
  attemptsLeft,
  modeAfterFailures,
  parseBootModePolicy,
  resolveBootMode,
  rolloutBucket,
  type BootModeTarget,
} from './boot-mode';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const target = (over: Partial<BootModeTarget> = {}): BootModeTarget => ({
  accountId: ORG_B,
  volumeProvider: true,
  projectVolumeFlag: false,
  envVolumeOff: false,
  ...over,
});

describe('boot modes', () => {
  test('a volume session steps down to artifacts, then to the image, and never off a volume it already uses', () => {
    const policy = parseBootModePolicy({ fallback: { volumeAttempts: 2, artifactsAttempts: 1 } }, true);
    expect(modeAfterFailures('volume', {}, policy, true)).toBe('volume');
    expect(attemptsLeft('volume', { volume: 1 }, policy)).toBe(true);
    expect(modeAfterFailures('volume', { volume: 1 }, policy, true)).toBe('volume');
    expect(modeAfterFailures('volume', { volume: 2 }, policy, true)).toBe('artifacts');
    expect(modeAfterFailures('volume', { volume: 2, artifacts: 1 }, policy, true)).toBe('standard');
    // The last step is per rule: off, the session stays on artifacts and fails there.
    expect(modeAfterFailures('volume', { volume: 2, artifacts: 1 }, policy, false)).toBe('artifacts');
    expect(attemptsLeft('artifacts', { artifacts: 1 }, policy)).toBe(false);
    // Its state is on the volume: booting without it would lose the session's files.
    expect(modeAfterFailures('volume', { volume: 9 }, policy, true, true)).toBe('volume');
    // No policy saved: today's env-driven behavior.
    expect(parseBootModePolicy(undefined, true).default.mode).toBe('artifacts');
    expect(parseBootModePolicy(undefined, false).default.mode).toBe('standard');
  });

  test('targeting: provider, kill switch, org, project flag, rollout, default', () => {
    const policy = parseBootModePolicy(
      {
        default: { mode: 'standard' },
        rollout: { mode: 'artifacts', percent: 100, standardFallback: false },
        orgs: { [ORG_A]: { mode: 'volume' } },
      },
      false,
    );
    expect(resolveBootMode(policy, target({ accountId: ORG_A, volumeProvider: false })).mode).toBe('standard');
    expect(resolveBootMode({ ...policy, killSwitch: true }, target({ accountId: ORG_A })).source).toBe('kill_switch');
    expect(resolveBootMode(policy, target({ accountId: ORG_A }))).toEqual({
      mode: 'volume',
      source: 'org',
      standardFallback: true,
    });
    expect(resolveBootMode(policy, target({ projectVolumeFlag: true })).source).toBe('project_flag');
    expect(resolveBootMode(policy, target())).toEqual({ mode: 'artifacts', source: 'rollout', standardFallback: false });
    expect(resolveBootMode({ ...policy, rollout: null }, target()).source).toBe('default');
    // The env switch still stops new volume boxes.
    expect(resolveBootMode(policy, target({ accountId: ORG_A, envVolumeOff: true })).mode).toBe('artifacts');
    // Rollout buckets are stable per org and partition by percent.
    const bucket = rolloutBucket(ORG_B);
    expect(rolloutBucket(ORG_B.toUpperCase())).toBe(bucket);
    const at = (percent: number) =>
      resolveBootMode({ ...policy, rollout: { mode: 'volume', percent, standardFallback: true } }, target()).source;
    expect(at(bucket)).toBe('default');
    expect(at(bucket + 1)).toBe('rollout');
  });
});

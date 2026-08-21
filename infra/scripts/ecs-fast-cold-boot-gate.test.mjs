import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deployScript = fileURLToPath(new URL('./ecs-deploy.sh', import.meta.url));

function runFunction(name, ...args) {
  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -uo pipefail; export KORTIX_ECS_DEPLOY_LIB=1; source "$1"; shift; "$@"',
      'bash',
      deployScript,
      name,
      ...args,
    ],
    { encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('fast cold boot deployment gate', () => {
  test('requires the capability only for a flag-on deployment that can use Platinum', () => {
    expect(runFunction(
      'fast_cold_boot_requires_atomic_admission',
      '{"KORTIX_FAST_COLD_BOOT_ENABLED":"true"}',
      '{"ALLOWED_SANDBOX_PROVIDERS":"platinum,daytona"}',
    ).status).toBe(0);

    for (const [overrides, secret] of [
      ['{"KORTIX_FAST_COLD_BOOT_ENABLED":"false"}', '{"ALLOWED_SANDBOX_PROVIDERS":"platinum"}'],
      ['{}', '{"ALLOWED_SANDBOX_PROVIDERS":"platinum"}'],
      ['{"KORTIX_FAST_COLD_BOOT_ENABLED":"true"}', '{"ALLOWED_SANDBOX_PROVIDERS":"daytona,e2b"}'],
    ]) {
      expect(runFunction('fast_cold_boot_requires_atomic_admission', overrides, secret).status).toBe(1);
    }

    for (const [overrides, secret] of [
      ['{', '{"ALLOWED_SANDBOX_PROVIDERS":"platinum"}'],
      ['{"KORTIX_FAST_COLD_BOOT_ENABLED":"true"}', '{'],
    ]) {
      const result = runFunction('fast_cold_boot_requires_atomic_admission', overrides, secret);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('refusing');
    }
  });

  test('accepts only an explicit atomic admission capability', () => {
    expect(runFunction(
      'validate_platinum_atomic_admission',
      '{"templates":{"used":4,"cap":500,"atomicAdmission":true}}',
    ).status).toBe(0);

    for (const quota of [
      '{"templates":{"used":4,"cap":500}}',
      '{"templates":{"used":4,"cap":500,"atomicAdmission":false}}',
      '{"templates":{"used":4,"cap":500,"atomicAdmission":"true"}}',
      '{}',
    ]) {
      const result = runFunction('validate_platinum_atomic_admission', quota);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('atomic template admission');
    }
  });
});

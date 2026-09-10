import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorkerQualityPlan } from '../src/core/worker-quality';

const root = resolve(import.meta.dirname, '../..');

describe('standalone worker quality gate', () => {
  it('installs from the standalone lock before testing, typechecking, and building', () => {
    const plan = buildWorkerQualityPlan();

    expect(plan.slice(0, 4)).toEqual([
      {
        name: 'install',
        command: ['bun', 'install', '--frozen-lockfile'],
        cwd: 'apps/kortix-worker',
      },
      {
        name: 'unit',
        command: ['bun', 'run', 'test'],
        cwd: 'apps/kortix-worker',
      },
      {
        name: 'typecheck',
        command: ['bun', 'run', 'typecheck'],
        cwd: 'apps/kortix-worker',
      },
      {
        name: 'build',
        command: ['bun', 'run', 'build'],
        cwd: 'apps/kortix-worker',
      },
    ]);
  });

  it('requires both real-bundle suites after the build', () => {
    const bundle = buildWorkerQualityPlan().at(-1);

    expect(bundle).toEqual({
      name: 'bundle',
      command: [
        'bun',
        'test',
        '--isolate',
        '--env-file=apps/api/scripts/test.env',
        'apps/api/src/git-proxy/pi-worker-bundle.test.ts',
        'apps/api/src/snapshots/pi-worker-lockdown.test.ts',
      ],
      env: { KORTIX_REQUIRE_PI_WORKER_BUNDLE: '1' },
    });
  });

  it('fails instead of skipping when a required bundle is absent', () => {
    for (const path of [
      'apps/api/src/git-proxy/pi-worker-bundle.test.ts',
      'apps/api/src/snapshots/pi-worker-lockdown.test.ts',
    ]) {
      const source = readFileSync(resolve(root, path), 'utf8');
      expect(source, path).toContain("process.env.KORTIX_REQUIRE_PI_WORKER_BUNDLE === '1'");
      expect(source, path).toContain('required pi worker bundle is missing');
    }
  });
});

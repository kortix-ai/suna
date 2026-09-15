export interface WorkerQualityStep {
  name: 'install' | 'unit' | 'typecheck' | 'build' | 'bundle';
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export function buildWorkerQualityPlan(): WorkerQualityStep[] {
  const workerCwd = 'apps/kortix-worker';
  return [
    {
      name: 'install',
      command: ['bun', 'install', '--frozen-lockfile'],
      cwd: workerCwd,
    },
    {
      name: 'unit',
      command: ['bun', 'run', 'test'],
      cwd: workerCwd,
    },
    {
      name: 'typecheck',
      command: ['bun', 'run', 'typecheck'],
      cwd: workerCwd,
    },
    {
      name: 'build',
      command: ['bun', 'run', 'build'],
      cwd: workerCwd,
    },
    {
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
    },
  ];
}

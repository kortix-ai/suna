import { describe, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'daytona,platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const { chunkForConcurrency, parsePrebuildConfig, runPrebuildMigration, prebuildExitCode } = await import(
  './provider-transition-prebuild'
);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const makeRow = (projectId: string, status = 'pending') => ({ transitionId: `t-${projectId}`, projectId, status }) as never;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const baseCfg = { policy: 'selected' as const, targetProvider: 'platinum', dryRun: false, limit: 1000 };

describe('prebuild config parsing', () => {
  test('defaults are sane', () => {
    const cfg = parsePrebuildConfig({});
    expect(cfg.targetProvider).toBe('platinum');
    expect(cfg.policy).toBe('recently-active');
    expect(cfg.concurrency).toBe(3);
    expect(cfg.dryRun).toBe(false);
  });

  test('argv overrides env overrides defaults', () => {
    const cfg = parsePrebuildConfig(
      { PREBUILD_POLICY: 'all-active', PREBUILD_CONCURRENCY: '9' },
      ['--policy=selected', '--projects=a,b,c', '--dry-run=true'],
    );
    expect(cfg.policy).toBe('selected');
    expect(cfg.projectIds).toEqual(['a', 'b', 'c']);
    expect(cfg.concurrency).toBe(9);
    expect(cfg.dryRun).toBe(true);
  });

  test('an unknown policy falls back to recently-active', () => {
    expect(parsePrebuildConfig({ PREBUILD_POLICY: 'nonsense' }).policy).toBe('recently-active');
  });
});

describe('concurrency chunking', () => {
  test('splits into bounded batches and never loses an id', () => {
    expect(chunkForConcurrency(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(chunkForConcurrency([], 3)).toEqual([]);
    expect(chunkForConcurrency(['x'], 0)).toEqual([['x']]);
  });
});

describe('runPrebuildMigration — bounded worker pool over actual drives', () => {
  test('never exceeds cfg.concurrency concurrent drives, and drains every drive', async () => {
    let active = 0;
    let maxActive = 0;
    let driven = 0;
    const deps = {
      requestPrebuild: async ({ projectId }: { projectId: string }) => makeRow(projectId),
      driveToTerminal: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await wait(10);
        active -= 1;
        driven += 1;
        return 'prebuilt' as const;
      },
      shouldStop: () => false,
    };
    const result = await runPrebuildMigration({} as never, { ...baseCfg, projectIds: ids(20), concurrency: 4 }, { deps });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(driven).toBe(20);
    expect(active).toBe(0); // no abandoned drives on normal completion
    expect(result.ready).toBe(20);
    expect(result.selected).toBe(20);
    expect(prebuildExitCode(result)).toBe(0);
  });

  test('rerun is idempotent — an already-ready row is skipped, never re-driven', async () => {
    let driveCalls = 0;
    const deps = {
      requestPrebuild: async ({ projectId }: { projectId: string }) => makeRow(projectId, 'ready'),
      driveToTerminal: async () => {
        driveCalls += 1;
        return 'prebuilt' as const;
      },
      shouldStop: () => false,
    };
    const result = await runPrebuildMigration({} as never, { ...baseCfg, projectIds: ids(5), concurrency: 3 }, { deps });
    expect(driveCalls).toBe(0);
    expect(result.alreadyReady).toBe(5);
    expect(result.ready).toBe(0);
    expect(prebuildExitCode(result)).toBe(0);
  });

  test('exit code reflects failures; a failure never aborts siblings', async () => {
    const deps = {
      requestPrebuild: async ({ projectId }: { projectId: string }) => makeRow(projectId),
      driveToTerminal: async (id: string) => (id.endsWith('2') ? ('failed' as const) : ('prebuilt' as const)),
      shouldStop: () => false,
    };
    const result = await runPrebuildMigration({} as never, { ...baseCfg, projectIds: ids(6), concurrency: 2 }, { deps });
    expect(result.failed).toBe(1); // only t-p2
    expect(result.ready).toBe(5);
    expect(prebuildExitCode(result)).toBe(1);
  });

  test('a thrown drive is counted, not propagated (allSettled semantics)', async () => {
    const deps = {
      requestPrebuild: async ({ projectId }: { projectId: string }) => makeRow(projectId),
      driveToTerminal: async (id: string) => {
        if (id.endsWith('1')) throw new Error('boom');
        return 'prebuilt' as const;
      },
      shouldStop: () => false,
    };
    const result = await runPrebuildMigration({} as never, { ...baseCfg, projectIds: ids(4), concurrency: 4 }, { deps });
    expect(result.failed).toBe(1);
    expect(result.ready).toBe(3);
  });

  test('SIGINT stops launching NEW drives but drains the in-flight ones', async () => {
    let started = 0;
    let finished = 0;
    let stop = false;
    const deps = {
      requestPrebuild: async ({ projectId }: { projectId: string }) => makeRow(projectId),
      driveToTerminal: async () => {
        started += 1;
        if (started >= 2) stop = true; // both pool slots busy → abort further launches
        await wait(10);
        finished += 1;
        return 'prebuilt' as const;
      },
      shouldStop: () => stop,
    };
    const result = await runPrebuildMigration({} as never, { ...baseCfg, projectIds: ids(10), concurrency: 2 }, { deps });
    expect(started).toBe(2); // no NEW drives beyond the 2 already in flight
    expect(finished).toBe(2); // both in-flight drives drained, not abandoned
    expect(result.aborted).toBe(true);
    expect(prebuildExitCode(result)).toBe(130);
  });

  test('a dry run selects but drives nothing', async () => {
    let driveCalls = 0;
    const deps = {
      requestPrebuild: async ({ projectId }: { projectId: string }) => makeRow(projectId),
      driveToTerminal: async () => {
        driveCalls += 1;
        return 'prebuilt' as const;
      },
      shouldStop: () => false,
    };
    const result = await runPrebuildMigration({} as never, { ...baseCfg, projectIds: ids(3), concurrency: 2, dryRun: true }, { deps });
    expect(driveCalls).toBe(0);
    expect(result.selected).toBe(3);
    expect(result.ready).toBe(0);
  });
});

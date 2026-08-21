import { afterEach, describe, expect, test } from 'bun:test';
import type { SandboxProviderAdapter } from './providers';

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
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('PLATINUM_API_URL', 'https://platinum.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_testkey');

const { ensureFastSandboxImage, ensureMetaSandboxImage, prepareSnapshotForReuse } = await import(
  './builder'
);
const { platinumProvider } = await import('./providers/platinum');

const originalWarn = console.warn;
const originalIsConfigured = platinumProvider.isConfigured;
const originalGetSnapshotState = platinumProvider.getSnapshotState;
const originalPrepareSnapshot = platinumProvider.prepareSnapshot;
const originalBuildSnapshot = platinumProvider.buildSnapshot;
const originalListSnapshots = platinumProvider.listSnapshots;

afterEach(() => {
  console.warn = originalWarn;
  platinumProvider.isConfigured = originalIsConfigured;
  platinumProvider.getSnapshotState = originalGetSnapshotState;
  platinumProvider.prepareSnapshot = originalPrepareSnapshot;
  platinumProvider.buildSnapshot = originalBuildSnapshot;
  platinumProvider.listSnapshots = originalListSnapshots;
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function provider(prepareSnapshot?: (snapshotName: string) => Promise<void>) {
  return {
    id: 'platinum',
    prepareSnapshot,
  } as Pick<SandboxProviderAdapter, 'id' | 'prepareSnapshot'>;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function expectSessionReuseDoesNotJoinBlockingPreparation(
  ensureImage: (opts: {
    source?: 'session-start' | 'startup';
    provider: string;
  }) => Promise<unknown>,
): Promise<void> {
  const firstGate = deferred();
  const firstStarted = deferred();
  let preparationCalls = 0;
  let stateCalls = 0;
  platinumProvider.isConfigured = () => true;
  platinumProvider.getSnapshotState = async () => {
    stateCalls += 1;
    return 'active';
  };
  platinumProvider.prepareSnapshot = async () => {
    preparationCalls += 1;
    if (preparationCalls === 1) {
      firstStarted.resolve();
      await firstGate.promise;
    }
  };

  const startup = ensureImage({ source: 'startup', provider: 'platinum' });
  await firstStarted.promise;
  let sessionSettled = false;
  const session = ensureImage({ source: 'session-start', provider: 'platinum' }).then(() => {
    sessionSettled = true;
  });

  try {
    await flushMicrotasks();
    expect(stateCalls).toBe(1);
    expect(preparationCalls).toBe(1);
    expect(sessionSettled).toBe(true);
  } finally {
    firstGate.resolve();
    await Promise.all([startup, session]);
  }
}

async function expectConcurrentColdBuildIsDeduplicated(
  ensureImage: (opts: { source?: 'session-start'; provider: string }) => Promise<unknown>,
): Promise<void> {
  const buildGate = deferred();
  const buildStarted = deferred();
  let stateCalls = 0;
  let buildCalls = 0;
  platinumProvider.isConfigured = () => true;
  platinumProvider.getSnapshotState = async () => {
    stateCalls += 1;
    return 'missing';
  };
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    buildStarted.resolve();
    await buildGate.promise;
    return { externalTemplateId: 'tpl_test' };
  };
  platinumProvider.listSnapshots = async () => [];

  const first = ensureImage({ source: 'session-start', provider: 'platinum' });
  const second = ensureImage({ source: 'session-start', provider: 'platinum' });
  await buildStarted.promise;

  expect(stateCalls).toBe(1);
  expect(buildCalls).toBe(1);
  buildGate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult).toBe(secondResult);
}

describe('prepareSnapshotForReuse', () => {
  test('returns the same value when the provider has no preparation capability', async () => {
    const result = { snapshotName: 'kortix-default-current' };

    expect(
      await prepareSnapshotForReuse(provider(), result.snapshotName, result, { blocking: true }),
    ).toBe(result);
  });

  test('waits for preparation in blocking mode', async () => {
    const gate = deferred();
    let settled = false;
    const result = { snapshotName: 'kortix-default-current' };
    const operation = prepareSnapshotForReuse(
      provider(async () => gate.promise),
      result.snapshotName,
      result,
      { blocking: true },
    ).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();

    expect(await operation).toBe(result);
  });

  test('starts preparation without waiting in non-blocking mode', async () => {
    const gate = deferred();
    let calls = 0;
    const result = { snapshotName: 'kortix-default-current' };

    const value = await prepareSnapshotForReuse(
      provider(async () => {
        calls += 1;
        await gate.promise;
      }),
      result.snapshotName,
      result,
      { blocking: false },
    );

    expect(value).toBe(result);
    expect(calls).toBe(1);
    gate.resolve();
  });

  test('shares one in-flight preparation across concurrent callers', async () => {
    const gate = deferred();
    let calls = 0;
    const adapter = provider(async () => {
      calls += 1;
      await gate.promise;
    });

    await prepareSnapshotForReuse(adapter, 'kortix-default-current', undefined, {
      blocking: false,
    });
    let blockingSettled = false;
    const blocking = prepareSnapshotForReuse(
      adapter,
      'kortix-default-current',
      undefined,
      { blocking: true },
    ).then(() => {
      blockingSettled = true;
    });
    await flushMicrotasks();

    expect(calls).toBe(1);
    expect(blockingSettled).toBe(false);
    gate.resolve();
    await blocking;
  });

  test.each([true, false])(
    'preserves the return value after a rejection when blocking=%s',
    async (blocking) => {
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      const result = { snapshotName: 'kortix-default-current' };

      const value = await prepareSnapshotForReuse(
        provider(async () => {
          throw new Error('materializer unavailable');
        }),
        result.snapshotName,
        result,
        { blocking },
      );
      await Promise.resolve();

      expect(value).toBe(result);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain('kortix-default-current');
      expect(String(warnings[0]?.[1])).toContain('materializer unavailable');
    },
  );
});

test('wires every active-reuse path through source-aware preparation', async () => {
  const source = await Bun.file(new URL('./builder.ts', import.meta.url)).text();

  expect(source.match(/prepareSnapshotForReuse\(/g)).toHaveLength(10);
  expect(source.match(/blocking: blockingPreparation/g)).toHaveLength(5);
  expect(
    source.match(/blocking: \(opts\.source \?\? 'session-start'\) !== 'session-start'/g),
  ).toHaveLength(2);
  expect(source.match(/blocking: true/g)).toHaveLength(2);
  expect(source.match(/activeName, undefined, \{ blocking: false \}/g)).toHaveLength(1);
});

test('a fast session reuse never joins startup preparation', async () => {
  await expectSessionReuseDoesNotJoinBlockingPreparation(ensureFastSandboxImage);
});

test('a meta session reuse never joins startup preparation', async () => {
  await expectSessionReuseDoesNotJoinBlockingPreparation(ensureMetaSandboxImage);
});

test('concurrent fast cold builds share one provider build', async () => {
  await expectConcurrentColdBuildIsDeduplicated(ensureFastSandboxImage);
});

test('concurrent meta cold builds share one provider build', async () => {
  await expectConcurrentColdBuildIsDeduplicated(ensureMetaSandboxImage);
});

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
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('PLATINUM_API_URL', 'https://platinum.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_testkey');

const { findFirstActiveSnapshot } = await import('./builder');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('findFirstActiveSnapshot', () => {
  test('uses the provider batch lookup when available', async () => {
    const names = ['scoped', 'unscoped', 'legacy'];
    const batches: string[][] = [];
    let stateCalls = 0;
    const provider = {
      findFirstActiveSnapshot: async (candidates: readonly string[]) => {
        batches.push([...candidates]);
        return 'unscoped';
      },
      getSnapshotState: async () => {
        stateCalls += 1;
        return 'active' as const;
      },
    };

    await expect(findFirstActiveSnapshot(provider, names)).resolves.toBe('unscoped');
    expect(batches).toEqual([names]);
    expect(stateCalls).toBe(0);
  });

  test('rejects a provider result outside the requested candidate set', async () => {
    await expect(
      findFirstActiveSnapshot(
        {
          findFirstActiveSnapshot: async () => 'foreign',
          getSnapshotState: async () => 'active',
        },
        ['scoped', 'unscoped'],
      ),
    ).rejects.toThrow('outside the requested candidate set');
  });

  test('starts fallback state reads in parallel and returns the first active name by candidate priority', async () => {
    const states = new Map([
      ['scoped', deferred<'active' | 'missing'>()],
      ['unscoped', deferred<'active' | 'missing'>()],
      ['legacy', deferred<'active' | 'missing'>()],
    ]);
    const calls: string[] = [];
    const result = findFirstActiveSnapshot(
      {
        getSnapshotState: async (name: string) => {
          calls.push(name);
          return states.get(name)!.promise;
        },
      },
      ['scoped', 'unscoped', 'legacy'],
    );

    expect(calls).toEqual(['scoped', 'unscoped', 'legacy']);
    states.get('legacy')!.resolve('active');
    states.get('unscoped')!.resolve('active');
    states.get('scoped')!.resolve('active');
    await expect(result).resolves.toBe('scoped');
  });

  test('returns null when every parallel fallback state is non-active', async () => {
    const calls: string[] = [];
    const result = await findFirstActiveSnapshot(
      {
        getSnapshotState: async (name: string) => {
          calls.push(name);
          return name === 'scoped' ? 'building' : 'missing';
        },
      },
      ['scoped', 'unscoped', 'legacy'],
    );

    expect(result).toBeNull();
    expect(calls).toEqual(['scoped', 'unscoped', 'legacy']);
  });
});

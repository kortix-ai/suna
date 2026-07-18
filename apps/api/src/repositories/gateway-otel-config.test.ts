import { beforeEach, describe, expect, mock, test } from 'bun:test';

let selectRows: any[] = [];
let selectCalls = 0;
let insertValues: any = null;
let onConflictSet: any = null;
let deleteWhereCalls = 0;

function selectChain(): any {
  const chain: any = {};
  for (const method of ['from', 'where', 'limit']) chain[method] = () => chain;
  chain.then = (resolve: (rows: any[]) => unknown) => Promise.resolve(resolve(selectRows));
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    select: () => {
      selectCalls += 1;
      return selectChain();
    },
    insert: () => ({
      values: (v: any) => {
        insertValues = v;
        return {
          onConflictDoUpdate: ({ set }: { set: any }) => {
            onConflictSet = set;
            return Promise.resolve();
          },
        };
      },
    }),
    delete: () => ({
      where: () => {
        deleteWhereCalls += 1;
        return Promise.resolve();
      },
    }),
  },
  hasDatabase: () => true,
}));

// API_KEY_SECRET must be set for encryptProjectSecret/decryptProjectSecret
// (projects/secrets.ts) — the surrounding suite runs under `dotenvx run` so a
// real value is already injected; this is only a defensive fallback so the
// file is runnable standalone too.
process.env.API_KEY_SECRET ||= 'test-only-not-a-real-secret-0123456789abcdef';

const {
  getProjectOtelConfigSummary,
  setProjectOtelConfig,
  deleteProjectOtelConfig,
  peekCachedProjectOtelExporter,
  invalidateProjectOtelExporterCache,
} = await import('./gateway-otel-config');

beforeEach(() => {
  selectRows = [];
  selectCalls = 0;
  insertValues = null;
  onConflictSet = null;
  deleteWhereCalls = 0;
});

describe('getProjectOtelConfigSummary', () => {
  test('returns a disabled/empty summary when no row exists', async () => {
    selectRows = [];
    expect(await getProjectOtelConfigSummary('proj-none')).toEqual({
      enabled: false,
      endpoint: null,
      hasHeaders: false,
      updatedAt: null,
    });
  });

  test('reports hasHeaders without ever exposing the decrypted value', async () => {
    selectRows = [
      {
        enabled: true,
        endpoint: 'https://otel.example.com/v1/traces',
        headersEnc: 'v1:iv:tag:ciphertext',
        updatedAt: new Date('2026-07-18T00:00:00.000Z'),
      },
    ];
    const summary = await getProjectOtelConfigSummary('proj-1');
    expect(summary.enabled).toBe(true);
    expect(summary.endpoint).toBe('https://otel.example.com/v1/traces');
    expect(summary.hasHeaders).toBe(true);
    expect(summary.updatedAt).toBe('2026-07-18T00:00:00.000Z');
    // Never the raw encrypted blob, and never a decrypted header value.
    expect(JSON.stringify(summary)).not.toContain('ciphertext');
  });
});

describe('setProjectOtelConfig', () => {
  test('encrypts headers before persisting — never stores the plaintext token', async () => {
    selectRows = []; // no prior row for the "leave headers untouched" branch check
    await setProjectOtelConfig({
      projectId: 'proj-1',
      updatedBy: 'user-1',
      enabled: true,
      endpoint: 'https://otel.example.com/v1/traces',
      headers: { Authorization: 'Bearer secret-token-xyz' },
    });

    expect(insertValues.projectId).toBe('proj-1');
    expect(insertValues.enabled).toBe(true);
    expect(insertValues.endpoint).toBe('https://otel.example.com/v1/traces');
    expect(insertValues.headersEnc).toBeTruthy();
    expect(insertValues.headersEnc).not.toContain('secret-token-xyz');
    expect(onConflictSet.headersEnc).toBe(insertValues.headersEnc);
  });

  test('omitting headers leaves the previously stored value untouched', async () => {
    selectRows = [{ headersEnc: 'v1:existing:blob:here' }];
    await setProjectOtelConfig({
      projectId: 'proj-1',
      updatedBy: 'user-1',
      enabled: false,
      endpoint: 'https://otel.example.com/v1/traces',
      // headers omitted entirely — toggling `enabled` only
    });
    expect(insertValues.headersEnc).toBe('v1:existing:blob:here');
  });

  test('passing an empty headers object clears the stored value', async () => {
    selectRows = [{ headersEnc: 'v1:existing:blob:here' }];
    await setProjectOtelConfig({
      projectId: 'proj-1',
      updatedBy: 'user-1',
      enabled: true,
      endpoint: 'https://otel.example.com/v1/traces',
      headers: {},
    });
    expect(insertValues.headersEnc).toBeNull();
  });

  test('invalidates the hot-path cache so the write takes effect immediately', async () => {
    selectRows = [{ enabled: true, endpoint: 'https://old.example.com', headersEnc: null }];
    // Warm the cache and let the background refresh settle.
    peekCachedProjectOtelExporter('proj-cache');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(peekCachedProjectOtelExporter('proj-cache')?.endpoint).toBe('https://old.example.com');

    selectRows = [{ enabled: true, endpoint: 'https://new.example.com', headersEnc: null }];
    await setProjectOtelConfig({
      projectId: 'proj-cache',
      updatedBy: 'user-1',
      enabled: true,
      endpoint: 'https://new.example.com',
      headers: {},
    });

    // Cache was invalidated by the write — next peek is a fresh miss (kicks a
    // background refresh) rather than serving the stale endpoint.
    peekCachedProjectOtelExporter('proj-cache');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(peekCachedProjectOtelExporter('proj-cache')?.endpoint).toBe('https://new.example.com');
  });
});

describe('deleteProjectOtelConfig', () => {
  test('deletes the row and invalidates the cache', async () => {
    await deleteProjectOtelConfig('proj-del');
    expect(deleteWhereCalls).toBe(1);
  });
});

describe('peekCachedProjectOtelExporter', () => {
  test('returns undefined on a cold project without blocking on the DB', () => {
    invalidateProjectOtelExporterCache('proj-cold');
    const result = peekCachedProjectOtelExporter('proj-cold');
    expect(result).toBeUndefined();
  });

  test('decrypts and parses headers once the background refresh settles', async () => {
    invalidateProjectOtelExporterCache('proj-headers');
    selectRows = [
      {
        enabled: true,
        endpoint: 'https://otel.example.com/v1/traces',
        headersEnc: (await import('../projects/secrets')).encryptProjectSecret(
          'proj-headers',
          'Authorization=Bearer tok-123,X-Extra=v',
        ),
      },
    ];
    peekCachedProjectOtelExporter('proj-headers'); // triggers the background load
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const config = peekCachedProjectOtelExporter('proj-headers');
    expect(config).toEqual({
      enabled: true,
      endpoint: 'https://otel.example.com/v1/traces',
      headers: { Authorization: 'Bearer tok-123', 'X-Extra': 'v' },
    });
  });
});

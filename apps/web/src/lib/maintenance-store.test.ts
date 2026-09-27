import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type Config = {
  level: 'none' | 'info' | 'blocking';
  title: string;
  message: string;
  updatedAt: string;
};

// One shared Edge Config store, exactly like dev/staging/prod in production:
// the item map is keyed, and every test asserts which key was touched.
let edgeItems: Map<string, Config>;
let databaseConfig: Config;
let databaseReadFails = false;
let edgeReadFails = false;
let events: string[] = [];
let edgeWrites: Array<{ key: string; value: Config }> = [];
let edgeReadKeys: string[] = [];
let apiFetches: string[] = [];

mock.module('@kortix/sdk', () => ({
  getMaintenanceConfig: async () => {
    events.push('database-read');
    if (databaseReadFails) throw new Error('API unavailable');
    return databaseConfig;
  },
  setMaintenanceConfig: async (config: Config) => {
    events.push('database-write');
    databaseConfig = { ...config, updatedAt: 'database-saved' };
    return databaseConfig;
  },
}));

mock.module('@vercel/edge-config', () => ({
  createClient: () => ({
    get: async (key: string, options?: { consistentRead?: boolean }) => {
      events.push(options?.consistentRead ? 'edge-read-consistent' : 'edge-read');
      edgeReadKeys.push(key);
      if (edgeReadFails) throw new Error('Edge Config unavailable');
      return edgeItems.get(key);
    },
  }),
}));

const originalFetch = globalThis.fetch;
const originalBackendUrl = process.env.BACKEND_URL;
process.env.EDGE_CONFIG = 'https://edge-config.example.test?token=redacted';
process.env.EDGE_CONFIG_ID = 'ecfg_test';
process.env.VERCEL_API_TOKEN = 'vercel-test-token';

const {
  getEdgeMaintenanceConfig,
  getMaintenanceConfig,
  maintenanceEdgeConfigKey,
  reconcileMaintenanceEdgeConfig,
  resolveMaintenanceEnvironment,
  sameMaintenanceState,
  setMaintenanceConfig,
  __resetEdgeMaintenanceMemoryForTests,
  __resetMaintenanceCacheForTests,
} = await import('./maintenance-store');

const STAGING_BLOCKING: Config = {
  level: 'blocking',
  title: 'Staging lockdown',
  message: 'Staging only.',
  updatedAt: 'staging-set',
};

function setApiHost(url: string | undefined): void {
  if (url === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = url;
}

beforeEach(() => {
  __resetMaintenanceCacheForTests();
  __resetEdgeMaintenanceMemoryForTests();
  setApiHost('https://api.kortix.com/v1');
  delete process.env.KORTIX_PUBLIC_BACKEND_URL;
  delete process.env.NEXT_PUBLIC_BACKEND_URL;
  databaseConfig = { level: 'none', title: '', message: '', updatedAt: 'database-current' };
  edgeItems = new Map([
    [
      'maintenance_config_prod',
      { level: 'info', title: 'Prod', message: 'Prod notice', updatedAt: 'prod-set' },
    ],
    ['maintenance_config_staging', STAGING_BLOCKING],
    // The legacy shared key every environment used to write.
    ['maintenance_config', { ...STAGING_BLOCKING, title: 'Legacy shared' }],
  ]);
  databaseReadFails = false;
  edgeReadFails = false;
  events = [];
  edgeWrites = [];
  edgeReadKeys = [];
  apiFetches = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    apiFetches.push(url);
    events.push('edge-write');
    const body = JSON.parse(String(init?.body));
    const { key, value } = body.items[0];
    edgeWrites.push({ key, value });
    edgeItems.set(key, value);
    return Response.json({ status: 'ok' });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalBackendUrl === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = originalBackendUrl;
  delete process.env.EDGE_CONFIG;
  delete process.env.EDGE_CONFIG_ID;
  delete process.env.VERCEL_API_TOKEN;
});

describe('environment-scoped key', () => {
  test('derives the environment from the API host', () => {
    setApiHost('https://api.kortix.com/v1');
    expect(resolveMaintenanceEnvironment()).toBe('prod');
    setApiHost('https://staging-api.kortix.com/v1');
    expect(resolveMaintenanceEnvironment()).toBe('staging');
    setApiHost('https://dev-api.kortix.com/v1/');
    expect(resolveMaintenanceEnvironment()).toBe('dev');
  });

  test('names one key per environment and never the legacy shared key', () => {
    expect(maintenanceEdgeConfigKey('prod')).toBe('maintenance_config_prod');
    expect(maintenanceEdgeConfigKey('staging')).toBe('maintenance_config_staging');
    expect(maintenanceEdgeConfigKey('dev')).toBe('maintenance_config_dev');
  });

  test('an unknown or missing API host owns no key', () => {
    for (const url of [
      undefined,
      'http://localhost:8008/v1',
      'https://api.example.test/v1',
      'not a url',
    ]) {
      setApiHost(url);
      expect(resolveMaintenanceEnvironment()).toBeNull();
      expect(maintenanceEdgeConfigKey()).toBeNull();
    }
  });

  test('a production read never sees staging blocking state', async () => {
    const config = await getMaintenanceConfig();

    expect(config.title).toBe('Prod');
    expect(edgeReadKeys).toEqual(['maintenance_config_prod']);
  });

  test('the edge write gate reads only its own environment key', async () => {
    setApiHost('https://staging-api.kortix.com/v1');
    const staging = await getEdgeMaintenanceConfig();
    setApiHost('https://api.kortix.com/v1');
    const prod = await getEdgeMaintenanceConfig();

    expect(staging.level).toBe('blocking');
    expect(prod.level).toBe('info');
    expect(edgeReadKeys).toEqual(['maintenance_config_staging', 'maintenance_config_prod']);
  });

  test('an unknown environment fails open without reading any key', async () => {
    setApiHost('https://api.example.test/v1');

    expect((await getMaintenanceConfig()).level).toBe('none');
    expect((await getEdgeMaintenanceConfig()).level).toBe('none');
    expect(edgeReadKeys).toEqual([]);
  });
});

describe('request path (middleware)', () => {
  test('reads Edge Config only: no database read, no Vercel API call', async () => {
    edgeItems.set('maintenance_config_prod', { ...databaseConfig, updatedAt: 'stale-edge' });

    await getMaintenanceConfig();

    expect(events).toEqual(['edge-read']);
    expect(apiFetches).toEqual([]);
  });

  test('stays read-only when the database would disagree', async () => {
    databaseConfig = { level: 'blocking', title: 'x', message: 'y', updatedAt: 'newer' };

    await getMaintenanceConfig();

    expect(events).not.toContain('database-read');
    expect(edgeWrites).toEqual([]);
  });

  test('serves a cached config within the TTL window', async () => {
    const first = await getMaintenanceConfig();
    events = [];

    const second = await getMaintenanceConfig();

    expect(second).toEqual(first);
    expect(events).toEqual([]);
  });

  test('does not serve one environment cache to another', async () => {
    await getMaintenanceConfig();
    setApiHost('https://staging-api.kortix.com/v1');

    const staging = await getMaintenanceConfig();

    expect(staging.level).toBe('blocking');
  });

  test('coalesces concurrent reads into a single Edge Config read', async () => {
    const [a, b, c] = await Promise.all([
      getMaintenanceConfig(),
      getMaintenanceConfig(),
      getMaintenanceConfig(),
    ]);

    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(events.filter((event) => event === 'edge-read')).toHaveLength(1);
  });
});

// ── Independent edge write gate (`GET /api/maintenance/edge`) ──────────────
//
// The api-router worker reads this route as `MAINTENANCE_STATE_URL` and, on
// `level: 'blocking'`, answers every non-read-only request to api.kortix.com
// with a 503 carrying `config.message`. Only a REAL admin state of THIS
// environment may produce that lockdown.
describe('edge write gate', () => {
  test('stays open when the environment key is absent (fresh deploy)', async () => {
    edgeItems.delete('maintenance_config_prod');

    const config = await getEdgeMaintenanceConfig();

    // The legacy shared key still holds a blocking state; it must be ignored.
    expect(config.level).toBe('none');
  });

  test('stays open when the Edge Config read throws with nothing cached', async () => {
    edgeReadFails = true;

    const config = await getEdgeMaintenanceConfig();

    // Better Stack, Kortix Frontend prod: this path produced 1,000+
    // `ApiError: Kortix is temporarily unavailable. Service will resume
    // automatically.` with no admin action behind it.
    expect(config.level).toBe('none');
    expect(config.message).toBe('');
  });

  test('keeps a real admin lockdown across a transient read failure', async () => {
    edgeItems.set('maintenance_config_prod', { ...STAGING_BLOCKING, title: 'Prod lockdown' });
    const locked = await getEdgeMaintenanceConfig();
    expect(locked.level).toBe('blocking');

    edgeReadFails = true;
    const duringBlip = await getEdgeMaintenanceConfig();

    expect(duringBlip).toEqual(locked);
  });

  test('a last-known value of another environment never leaks', async () => {
    setApiHost('https://staging-api.kortix.com/v1');
    expect((await getEdgeMaintenanceConfig()).level).toBe('blocking');

    setApiHost('https://api.kortix.com/v1');
    edgeReadFails = true;
    const prod = await getEdgeMaintenanceConfig();

    expect(prod.level).toBe('none');
  });
});

describe('admin write path', () => {
  test('writes the database first, then this environment key only', async () => {
    const saved = await setMaintenanceConfig(
      {
        level: 'blocking',
        title: 'Database cutover',
        message: 'Writes are paused.',
        updatedAt: 'request-time',
      },
      'admin-token',
    );

    expect(saved.updatedAt).toBe('database-saved');
    expect(edgeWrites).toEqual([{ key: 'maintenance_config_prod', value: saved }]);
    expect(edgeItems.get('maintenance_config_staging')).toEqual(STAGING_BLOCKING);
    expect(events).toEqual(['database-write', 'edge-write', 'edge-read-consistent']);
  });

  test('takes effect on the next request-path read', async () => {
    await getMaintenanceConfig();

    await setMaintenanceConfig(
      { level: 'blocking', title: 'Lockdown', message: 'Paused.', updatedAt: 'request-time' },
      'admin-token',
    );
    events = [];

    const config = await getMaintenanceConfig();

    expect(config.level).toBe('blocking');
    expect(events).toEqual(['edge-read']);
  });

  test('an unknown environment saves the database and writes no Edge Config key', async () => {
    setApiHost('https://api.example.test/v1');

    await setMaintenanceConfig(
      { level: 'blocking', title: 'x', message: 'y', updatedAt: 'request-time' },
      'admin-token',
    );

    expect(events).toEqual(['database-write']);
    expect(edgeWrites).toEqual([]);
  });
});

describe('background reconcile', () => {
  test('compares level and updatedAt, not the whole object', () => {
    const base = { level: 'none' as const, updatedAt: 't1' };
    expect(sameMaintenanceState(base, { ...base })).toBe(true);
    expect(sameMaintenanceState(base, { ...base, updatedAt: 't2' })).toBe(false);
    expect(sameMaintenanceState(base, { ...base, level: 'info' })).toBe(false);
    expect(sameMaintenanceState(null, base)).toBe(false);
  });

  test('seeds an empty environment key from the database', async () => {
    edgeItems.delete('maintenance_config_prod');

    await reconcileMaintenanceEdgeConfig();

    expect(edgeWrites).toEqual([{ key: 'maintenance_config_prod', value: databaseConfig }]);
  });

  test('does not write when level and updatedAt already agree', async () => {
    edgeItems.set('maintenance_config_prod', { ...databaseConfig, title: 'cosmetic difference' });

    await reconcileMaintenanceEdgeConfig();

    expect(edgeWrites).toEqual([]);
  });

  test('runs at most once per interval per instance', async () => {
    await reconcileMaintenanceEdgeConfig();
    events = [];

    await reconcileMaintenanceEdgeConfig();

    expect(events).toEqual([]);
  });

  test('never throws and never writes when the database is unreadable', async () => {
    databaseReadFails = true;

    await reconcileMaintenanceEdgeConfig();

    expect(edgeWrites).toEqual([]);
  });

  test('does nothing for an unknown environment', async () => {
    setApiHost(undefined);

    await reconcileMaintenanceEdgeConfig();

    expect(events).toEqual([]);
  });
});

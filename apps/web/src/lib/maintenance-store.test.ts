import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type Config = {
  level: 'none' | 'blocking';
  title: string;
  message: string;
  updatedAt: string;
};

let databaseConfig: Config;
let edgeConfig: Config | null;
let databaseReadFails = false;
let edgeReadFails = false;
let events: string[] = [];

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
    get: async (_key: string, options?: { consistentRead?: boolean }) => {
      events.push(options?.consistentRead ? 'edge-read-consistent' : 'edge-read');
      if (edgeReadFails) throw new Error('Edge Config unavailable');
      return edgeConfig;
    },
  }),
}));

const originalFetch = globalThis.fetch;
process.env.EDGE_CONFIG = 'https://edge-config.example.test?token=redacted';
process.env.EDGE_CONFIG_ID = 'ecfg_test';
process.env.VERCEL_API_TOKEN = 'vercel-test-token';

const {
  getEdgeMaintenanceConfig,
  getMaintenanceConfig,
  setMaintenanceConfig,
  __resetEdgeMaintenanceMemoryForTests,
  __resetMaintenanceCacheForTests,
} = await import('./maintenance-store');

beforeEach(() => {
  __resetMaintenanceCacheForTests();
  __resetEdgeMaintenanceMemoryForTests();
  databaseConfig = {
    level: 'none',
    title: '',
    message: '',
    updatedAt: 'database-current',
  };
  edgeConfig = {
    level: 'blocking',
    title: 'Old state',
    message: 'Old state',
    updatedAt: 'edge-old',
  };
  databaseReadFails = false;
  edgeReadFails = false;
  events = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    events.push('edge-write');
    const body = JSON.parse(String(init?.body));
    edgeConfig = body.items[0].value;
    return Response.json({ status: 'ok' });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete process.env.EDGE_CONFIG;
  delete process.env.EDGE_CONFIG_ID;
  delete process.env.VERCEL_API_TOKEN;
});

describe('maintenance store', () => {
  test('uses the database and reconciles Edge Config', async () => {
    const config = await getMaintenanceConfig();

    expect(config).toEqual(databaseConfig);
    expect(edgeConfig).toEqual(databaseConfig);
    expect(events).toEqual(['database-read', 'edge-read', 'edge-write', 'edge-read-consistent']);
  });

  test('uses blocking Edge Config when the API is unavailable', async () => {
    databaseReadFails = true;

    const config = await getMaintenanceConfig();

    expect(config).toEqual(edgeConfig);
    expect(events).toEqual(['database-read', 'edge-read']);
  });

  test('returns normal (none) when the API is unavailable and Edge Config is none', async () => {
    databaseReadFails = true;
    edgeConfig = {
      level: 'none',
      title: '',
      message: '',
      updatedAt: 'edge-none',
    };

    const config = await getMaintenanceConfig();

    // Fail open: a transient API blip (deploy, GC pause) should not
    // trigger blocking maintenance. Only return blocking if Edge Config
    // explicitly has it.
    expect(config.level).toBe('none');
  });

  test('writes the database before Edge Config', async () => {
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
    expect(edgeConfig).toEqual(saved);
    expect(events).toEqual(['database-write', 'edge-write', 'edge-read-consistent']);
  });

  test('serves a cached config within the TTL window', async () => {
    const first = await getMaintenanceConfig();
    events = [];

    const second = await getMaintenanceConfig();

    expect(second).toEqual(first);
    expect(events).toEqual([]);
  });

  test('coalesces concurrent reads into a single upstream read', async () => {
    const [a, b, c] = await Promise.all([
      getMaintenanceConfig(),
      getMaintenanceConfig(),
      getMaintenanceConfig(),
    ]);

    expect(a).toEqual(databaseConfig);
    expect(b).toEqual(databaseConfig);
    expect(c).toEqual(databaseConfig);
    expect(events.filter((event) => event === 'database-read')).toHaveLength(1);
  });

  // ── Independent edge write gate (`GET /api/maintenance/edge`) ──────────
  //
  // The api-router worker reads this route as `MAINTENANCE_STATE_URL` and, on
  // `level: 'blocking'`, answers every non-read-only request to api.kortix.com
  // with a 503 carrying `config.message`. These tests pin that only a REAL
  // admin state can produce that lockdown.

  test('edge gate reports the stored Edge Config state', async () => {
    const config = await getEdgeMaintenanceConfig();

    expect(config).toEqual(edgeConfig);
  });

  test('edge gate stays open when the Edge Config key is absent', async () => {
    edgeConfig = null;

    const config = await getEdgeMaintenanceConfig();

    // No admin has ever written the key. That is normal operation, not a
    // lockdown — returning `blocking` here 503'd every production write.
    expect(config.level).toBe('none');
  });

  test('edge gate stays open when the Edge Config read throws with nothing cached', async () => {
    edgeReadFails = true;

    const config = await getEdgeMaintenanceConfig();

    // Better Stack, Kortix Frontend prod: this path produced 1,000+
    // `ApiError: Kortix is temporarily unavailable. Service will resume
    // automatically.` with no admin action behind it.
    expect(config.level).toBe('none');
    expect(config.message).toBe('');
  });

  test('edge gate keeps a real admin lockdown across a transient read failure', async () => {
    const locked = await getEdgeMaintenanceConfig();
    expect(locked.level).toBe('blocking');

    edgeReadFails = true;
    const duringBlip = await getEdgeMaintenanceConfig();

    // An admin really did set `blocking`; a failed read must not undo it.
    expect(duringBlip).toEqual(locked);
  });

  test('setMaintenanceConfig invalidates the cache immediately', async () => {
    await getMaintenanceConfig();

    await setMaintenanceConfig(
      {
        level: 'blocking',
        title: 'Lockdown',
        message: 'Paused.',
        updatedAt: 'request-time',
      },
      'admin-token',
    );
    events = [];

    await getMaintenanceConfig();

    expect(events).toContain('database-read');
  });
});

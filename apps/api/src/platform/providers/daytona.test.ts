// Regression coverage for the 2026-07-02 incident: the Daytona SDK's axios
// client has a 24-HOUR default timeout, so a degraded upstream left
// getStatus()/stop()/start() etc. pending indefinitely. One hung call inside
// the reaper's worker pool (sandbox-reaper.ts) never let its Promise.all
// settle, which never let maintenance.ts's outer Promise.all settle, which
// meant its `finally { maintenanceRunning = false }` never ran — the
// maintenance loop's lock was stuck `true` forever, silently, with zero error
// logs, until the process restarted. This proves getStatus() now gives up on
// a hung upstream call within the configured bound instead of hanging.
import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('../../config', () => ({
  config: {
    DAYTONA_API_KEY: 'test-key',
    DAYTONA_SERVER_URL: '',
    DAYTONA_TARGET: '',
    INTERNAL_KORTIX_ENV: 'test',
    KORTIX_URL: 'https://api.example.com',
  },
  SANDBOX_VERSION: 'test-version',
}));

mock.module('../../shared/db', () => ({ db: {} , auditDb: {}}));

let getDaytonaSandbox: (_externalId: string) => Promise<unknown>;
let activityRefreshes: string[];

mock.module('../../shared/daytona', () => ({
  getDaytona: () => ({
    get: (externalId: string) => getDaytonaSandbox(externalId),
  }),
  // Disk-quota-guard deps (fix(sandbox) #4072) — only referenced by
  // create()/start(), not by getStatus() under test here, but imported at
  // module load so they must exist as named exports for the mock to satisfy
  // platform/providers/daytona.ts's import statement.
  archiveDaytonaSandboxById: async () => ({ ok: true }),
  isDaytonaDiskQuotaError: () => false,
  listStoppedDaytonaSandboxesOldestFirst: async function* () {},
}));

mock.module('../../projects/disk-quota-guard', () => ({
  triggerEmergencyDiskArchiveSweep: () => {},
}));

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => null,
}));

mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.com',
}));

beforeEach(() => {
  // Below the code's own 1000ms floor (Math.max(1000, …)) would just get
  // clamped up — use a value comfortably above it.
  process.env.KORTIX_DAYTONA_CALL_TIMEOUT_MS = '1200';
  activityRefreshes = [];
  getDaytonaSandbox = () => new Promise<never>(() => {});
});

test('renewLifecycle refreshes provider activity for a running sandbox', async () => {
  getDaytonaSandbox = async () => ({
    id: 'sbx_active',
    state: 'started',
    refreshActivity: async () => {
      activityRefreshes.push('sbx_active');
    },
  });
  const { DaytonaProvider } = await import('./daytona');

  await new DaytonaProvider().renewLifecycle('sbx_active');

  expect(activityRefreshes).toEqual(['sbx_active']);
});

test('renewLifecycle never refreshes a stopped sandbox', async () => {
  getDaytonaSandbox = async () => ({
    id: 'sbx_stopped',
    state: 'stopped',
    refreshActivity: async () => {
      activityRefreshes.push('sbx_stopped');
    },
  });
  const { DaytonaProvider } = await import('./daytona');

  await expect(new DaytonaProvider().renewLifecycle('sbx_stopped')).rejects.toThrow(
    'non-running sandbox',
  );
  expect(activityRefreshes).toEqual([]);
});

test('renewLifecycle rejects a failed activity refresh instead of reporting renewal', async () => {
  getDaytonaSandbox = async () => ({
    id: 'sbx_failed',
    state: 'started',
    refreshActivity: async () => {
      throw new Error('activity refresh unavailable');
    },
  });
  const { DaytonaProvider } = await import('./daytona');

  await expect(new DaytonaProvider().renewLifecycle('sbx_failed')).rejects.toThrow(
    'activity refresh unavailable',
  );
});

test('renewLifecycle bounds a hung activity refresh', async () => {
  getDaytonaSandbox = async () => ({
    id: 'sbx_hung',
    state: 'started',
    refreshActivity: () => new Promise<never>(() => {}),
  });
  const { DaytonaProvider } = await import('./daytona');

  const startedAt = Date.now();
  await expect(new DaytonaProvider().renewLifecycle('sbx_hung')).rejects.toThrow(
    'Daytona lifecycle renewal(sbx_hung) timed out after 1200ms',
  );
  expect(Date.now() - startedAt).toBeLessThan(5_000);
});

test('getStatus() gives up on a hung Daytona call instead of hanging forever', async () => {
  const { DaytonaProvider } = await import('./daytona');
  const provider = new DaytonaProvider();

  const start = Date.now();
  const status = await provider.getStatus('sbx_test');
  const elapsed = Date.now() - start;

  // getStatus() already catches all errors (including our TimeoutError) and
  // degrades to 'unknown' — the point under test is that it RETURNS at all,
  // bounded, instead of hanging on the SDK's 24h-class default.
  expect(status).toBe('unknown');
  expect(elapsed).toBeLessThan(5_000);
});

test('getStatus() reports missing Daytona sandboxes as removed', async () => {
  getDaytonaSandbox = async () => {
    const err = new Error('sandbox not found');
    (err as { status?: number; code?: string }).status = 404;
    (err as { status?: number; code?: string }).code = 'not_found';
    throw err;
  };

  const { DaytonaProvider } = await import('./daytona');
  const provider = new DaytonaProvider();

  await expect(provider.getStatus('sbx_missing')).resolves.toBe('removed');
});

// 720 (12h), not the 60 this returned while it doubled as the billing grace —
// see providerAutoStopBackstopMinutes() and ./autostop-backstop.test.ts. The
// timer sees only inbound traffic, so a turn spent in local tools resets
// nothing; 12h clears the 8.4h worst turn measured on 30 days of prod.
test('native auto-stop is a backstop that clears the longest measured turn', async () => {
  const { daytonaLifecycle } = await import('./daytona');
  const { providerAutoStopBackstopMinutes } = await import('./index');

  expect(providerAutoStopBackstopMinutes()).toBe(720);
  expect(daytonaLifecycle().autoStopInterval).toBe(720);
  expect(daytonaLifecycle(5).autoStopInterval).toBe(5);
  expect(daytonaLifecycle(0).autoStopInterval).toBe(1);
});

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

mock.module('../../shared/db', () => ({ db: {} }));

let getDaytonaSandbox: (_externalId: string) => Promise<unknown>;

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
  getDaytonaSandbox = () => new Promise<never>(() => {});
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

test('native auto-stop is a backstop clamped well above the reaper TTL', async () => {
  const { daytonaLifecycle } = await import('./daytona');
  const { providerAutoStopBackstopMinutes } = await import('./index');

  expect(providerAutoStopBackstopMinutes()).toBe(60);
  expect(daytonaLifecycle().autoStopInterval).toBe(60);
  expect(daytonaLifecycle(5).autoStopInterval).toBe(5);
  expect(daytonaLifecycle(0).autoStopInterval).toBe(1);
});

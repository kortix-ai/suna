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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test.each(['starting', 'started'])('start joins a concurrent provider wake in state %s', async (state) => {
  const conflict = Object.assign(new Error('Sandbox state change in progress'), { statusCode: 409 });
  const starts: number[] = [];
  const waits: number[] = [];
  let reads = 0;
  getDaytonaSandbox = async () => ++reads === 1
    ? { start: async (timeout: number) => { starts.push(timeout); throw conflict; } }
    : { state, waitUntilStarted: async (timeout: number) => { waits.push(timeout); } };
  const { DaytonaProvider } = await import('./daytona');
  await expect(new DaytonaProvider().start('sbx_concurrent')).resolves.toBeUndefined();
  expect(starts).toEqual([1.2]);
  expect(waits).toEqual(state === 'starting' ? [1.2] : []);
  expect(reads).toBe(2);
});

test.each(['stopped', 'stopping', 'error'])('start rejects a conflict when state %s does not prove another wake', async (state) => {
  const conflict = Object.assign(new Error('Sandbox state change in progress'), { statusCode: 409 });
  let reads = 0;
  getDaytonaSandbox = async () => ++reads === 1
    ? { start: async () => { throw conflict; } }
    : { state, waitUntilStarted: async () => { throw new Error('Must not wait'); } };
  const { DaytonaProvider } = await import('./daytona');
  await expect(new DaytonaProvider().start('sbx_conflict')).rejects.toBe(conflict);
});

test('start preserves non-conflict provider failures', async () => {
  const failure = Object.assign(new Error('Disk quota reached'), { statusCode: 400 });
  let reads = 0;
  getDaytonaSandbox = async () => { reads++; return { start: async () => { throw failure; } }; };
  const { DaytonaProvider } = await import('./daytona');
  await expect(new DaytonaProvider().start('sbx_quota')).rejects.toBe(failure);
  expect(reads).toBe(1);
});

test('start bounds a concurrent wake that never becomes ready', async () => {
  const conflict = Object.assign(new Error('Sandbox state change in progress'), { statusCode: 409 });
  let reads = 0;
  getDaytonaSandbox = async () => ++reads === 1
    ? { start: async () => { throw conflict; } }
    : { state: 'starting', waitUntilStarted: () => new Promise<never>(() => {}) };
  const { DaytonaProvider } = await import('./daytona');
  await expect(new DaytonaProvider().start('sbx_waiting')).rejects.toThrow('timed out after 1200ms');
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


test('runtime bootstrap probes the configured port through the actual shell command', async () => {
  const listener = Bun.serve({ port: 0, fetch: () => new Response('ready') });
  const results: Array<{ exitCode: number; result: string }> = [];
  getDaytonaSandbox = async () => ({
    process: {
      executeCommand: async (command: string) => {
        const child = Bun.spawn(['/bin/sh', '-c', command], {
          env: { ...process.env, KORTIX_SERVICE_PORT: String(listener.port) },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const result = { exitCode, result: stdout + stderr };
        results.push(result);
        return result;
      },
    },
  });
  try {
    const { DaytonaProvider } = await import('./daytona');
    await new DaytonaProvider().ensureSessionRuntimeStarted('sbx_active');
    expect(results).toEqual([{ exitCode: 0, result: 'already-listening\n' }]);
  } finally {
    listener.stop(true);
  }
});

test('runtime bootstrap detaches a worker with the lock descriptor held through its lifetime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daytona-bootstrap-'));
  const record = join(root, 'flock-args');
  const refRecord = join(root, 'runtime-ref');
  const launchRecord = join(root, 'launch-args');
  await writeFile(join(root, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(join(root, 'flock'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$BOOTSTRAP_RECORD"\nprintf "%s" "$KORTIX_PI_RUNTIME_REF" > "$BOOTSTRAP_REF_RECORD"\n', { mode: 0o755 });
  await writeFile(join(root, 'setsid'), '#!/bin/sh\ntest -e /dev/fd/9 || exit 70\nprintf "%s\\n" "$@" > "$BOOTSTRAP_LAUNCH_RECORD"\n', { mode: 0o755 });
  getDaytonaSandbox = async () => ({
    process: {
      executeCommand: async (command: string) => {
        const child = Bun.spawn(['/bin/sh', '-c', command], {
          env: { ...process.env, PATH: root + ':' + process.env.PATH, BOOTSTRAP_RECORD: record, BOOTSTRAP_REF_RECORD: refRecord, BOOTSTRAP_LAUNCH_RECORD: launchRecord, KORTIX_PI_RUNTIME_REF: 'main', KORTIX_PI_RUNTIME_SHA: 'a'.repeat(40) },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, result: stdout + stderr };
      },
    },
  });
  try {
    const { DaytonaProvider } = await import('./daytona');
    await new DaytonaProvider().ensureSessionRuntimeStarted('sbx_stopped');
    expect(await readFile(refRecord, 'utf8')).toBe('a'.repeat(40));
    expect((await readFile(record, 'utf8')).split('\n')).toEqual([
      '-n',
      '9',
      '',
    ]);
    for (let i = 0; i < 100 && !(await Bun.file(launchRecord).exists()); i++) await Bun.sleep(5);
    expect(await readFile(launchRecord, 'utf8')).toBe('/usr/local/bin/pi-worker-entrypoint\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('runtime bootstrap reports a launch failure instead of treating it as lock contention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daytona-bootstrap-'));
  await writeFile(join(root, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(join(root, 'flock'), '#!/bin/sh\necho cannot-create-lock >&2\nexit 73\n', { mode: 0o755 });
  getDaytonaSandbox = async () => ({
    process: {
      executeCommand: async (command: string) => {
        const child = Bun.spawn(['/bin/sh', '-c', command], {
          env: { ...process.env, PATH: root + ':' + process.env.PATH },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, result: stdout + stderr };
      },
    },
  });
  try {
    const { DaytonaProvider } = await import('./daytona');
    await expect(new DaytonaProvider().ensureSessionRuntimeStarted('sbx_failed')).rejects.toThrow(
      'exit 73: cannot-create-lock',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

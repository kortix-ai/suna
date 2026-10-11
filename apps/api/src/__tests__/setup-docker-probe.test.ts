/**
 * The setup status docker probe must not block the API event loop.
 *
 * Regression for KRTX-2108: the probe ran the synchronous
 * `spawnSync('docker', ['info'], { timeout: 10000 })` inside the async route
 * handler, so a hung docker daemon stalled every concurrent request on that
 * worker for up to 10 s. The probe now awaits `execFile` with the same 10 s
 * budget. The first test hangs the mocked exec/spawn on its first call and
 * asserts a second request still completes while the first probe is in
 * flight — under the synchronous probe that second request queues behind the
 * blocked event loop and the latency assertion fails.
 */

import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import * as realChildProcess from 'child_process';

/** Mutable probe state the mocked child_process functions read and record. */
const probe = { calls: 0, mode: 'hang-first' as 'hang-first' | 'missing' | 'timeout' | 'ok', blockMs: 0 };

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: () => Promise<void>) => {
    c.set('userId', '00000000-0000-0000-0000-000000000000');
    c.set('userEmail', 'agent@example.test');
    await next();
  },
}));

mock.module('child_process', () => ({
  ...realChildProcess,
  // Pre-fix path: spawnSync blocks the event loop for blockMs, then returns
  // per `mode` the way the real spawn reports spawn failure and timeout kills.
  spawnSync: () => {
    busyBlock(probe.blockMs);
    probe.calls += 1;
    if (probe.mode === 'missing') return { status: null };
    if (probe.mode === 'timeout') return { status: null, signal: 'SIGTERM' };
    return { status: 0 };
  },
  // Current path: execFile. The first call simulates a hung daemon (the
  // callback never fires); the others settle immediately per `mode`.
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    probe.calls += 1;
    if (probe.mode === 'hang-first' && probe.calls === 1) return;
    if (probe.mode === 'missing') {
      queueMicrotask(() => cb(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })));
      return;
    }
    if (probe.mode === 'timeout') {
      queueMicrotask(() => cb(Object.assign(new Error('docker info timed out'), { killed: true, signal: 'SIGTERM' })));
      return;
    }
    queueMicrotask(() => cb(null));
  },
}));

const { setupApp } = await import('../setup');

/** Deliberately spin the main thread: simulates spawnSync blocking the loop. */
function busyBlock(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}

function testApp(): Hono {
  const app = new Hono();
  app.route('/v1/setup', setupApp);
  return app;
}

describe('GET /v1/setup/status docker probe', () => {
  it('serves concurrent requests while the docker probe is in flight', async () => {
    const app = testApp();
    probe.calls = 0;
    probe.mode = 'hang-first';
    probe.blockMs = 1500;

    const hung = app.request('/v1/setup/status'); // its probe never settles

    const started = performance.now();
    const res = await app.request('/v1/setup/status');
    const elapsedMs = performance.now() - started;

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dockerRunning).toBe(true);
    expect(probe.calls).toBe(2);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('maps a missing docker binary to dockerRunning=false', async () => {
    const app = testApp();
    probe.calls = 0;
    probe.mode = 'missing';
    probe.blockMs = 0;

    const res = await app.request('/v1/setup/status');

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dockerRunning).toBe(false);
    expect(probe.calls).toBe(1);
  });

  it('maps a timed-out docker probe to dockerRunning=false', async () => {
    const app = testApp();
    probe.calls = 0;
    probe.mode = 'timeout';
    probe.blockMs = 0;

    const res = await app.request('/v1/setup/status');

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dockerRunning).toBe(false);
    expect(probe.calls).toBe(1);
  });

  it('returns the unchanged response shape on success', async () => {
    const app = testApp();
    probe.calls = 0;
    probe.mode = 'ok';
    probe.blockMs = 0;

    const res = await app.request('/v1/setup/status');

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Object.keys(data).sort()).toEqual([
      'billingEnabled',
      'dockerRunning',
      'envExists',
      'projectRoot',
      'sandboxEnvExists',
    ]);
    expect(data.dockerRunning).toBe(true);
    expect(typeof data.billingEnabled).toBe('boolean');
    expect(typeof data.envExists).toBe('boolean');
    expect(data.sandboxEnvExists).toBe(false);
    expect(typeof data.projectRoot).toBe('string');
  });
});

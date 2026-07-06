import { describe, expect, test } from 'bun:test';

import { waitForDaemonOpencodeReady } from '../projects/lib/sandbox-daemon-ready';

type HealthBody = { opencode?: string; status?: string };

// A fake fetch that walks a fixed sequence of /kortix/health responses. 'fail'
// models an unreachable probe (non-2xx); the last entry repeats once exhausted.
function fakeHealthFetch(sequence: Array<HealthBody | 'fail'>): typeof fetch {
  let i = 0;
  return (async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    if (step === 'fail') return new Response('unreachable', { status: 503 });
    return new Response(JSON.stringify(step), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

// Virtual clock so polling advances without real timers.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('waitForDaemonOpencodeReady', () => {
  test('resolves true once opencode reports ok (the post-restart window clears)', async () => {
    const clock = fakeClock();
    const ready = await waitForDaemonOpencodeReady({
      previewUrl: 'http://127.0.0.1:1/',
      previewToken: null,
      deps: {
        fetchImpl: fakeHealthFetch([
          { opencode: 'starting' },
          { opencode: 'starting' },
          { opencode: 'ok', status: 'ok' },
        ]),
        sleep: clock.sleep,
        now: clock.now,
      },
    });
    expect(ready).toBe(true);
  });

  test('keeps polling through a transient unreachable probe, then succeeds', async () => {
    const clock = fakeClock();
    const ready = await waitForDaemonOpencodeReady({
      previewUrl: 'http://127.0.0.1:1/',
      previewToken: 'tok',
      deps: {
        fetchImpl: fakeHealthFetch(['fail', { opencode: 'starting' }, { opencode: 'ok' }]),
        sleep: clock.sleep,
        now: clock.now,
      },
    });
    expect(ready).toBe(true);
  });

  test('short-circuits false on a boot error — waiting cannot fix repo/init failures', async () => {
    const clock = fakeClock();
    const ready = await waitForDaemonOpencodeReady({
      previewUrl: 'http://127.0.0.1:1/',
      previewToken: null,
      deps: {
        fetchImpl: fakeHealthFetch([{ opencode: 'down', status: 'error' }]),
        sleep: clock.sleep,
        now: clock.now,
      },
    });
    expect(ready).toBe(false);
  });

  test('gives up false when the budget is exhausted (cold boot overruns)', async () => {
    const clock = fakeClock();
    const ready = await waitForDaemonOpencodeReady({
      previewUrl: 'http://127.0.0.1:1/',
      previewToken: null,
      budgetMs: 1_000,
      deps: {
        fetchImpl: fakeHealthFetch([{ opencode: 'starting' }]),
        sleep: clock.sleep,
        now: clock.now,
      },
    });
    expect(ready).toBe(false);
  });
});

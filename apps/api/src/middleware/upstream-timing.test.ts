import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { runWithContext } from '../lib/request-context';
import {
  recordUpstreamMs,
  timeUpstream,
  upstreamMsSoFar,
  upstreamTiming,
} from './upstream-timing';

/**
 * A session open spends ~1.7 s on `GET /v1/p/<ext>/8000/agent`, and from
 * outside the box a HAR shows one number: no way to tell the sandbox hop from
 * the API's own work. `Server-Timing: up;dur=…, api;dur=…` is what makes that
 * split readable by the next measurement pass, so these tests pin the split
 * itself, the accumulation across retries, and the header actually shipping.
 */

function parseServerTiming(value: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of (value ?? '').split(',')) {
    const match = /^\s*([\w-]+)\s*;\s*dur=([\d.]+)\s*$/.exec(entry);
    if (match) out[match[1]!] = Number(match[2]);
  }
  return out;
}

describe('recordUpstreamMs', () => {
  test('accumulates across calls inside one request', async () => {
    // A retried upstream fetch must ADD, not overwrite — otherwise a request
    // that burned three attempts reports only the last one.
    const total = await runWithContext('GET', '/x', async () => {
      recordUpstreamMs(100);
      recordUpstreamMs(50);
      recordUpstreamMs(25);
      return upstreamMsSoFar();
    });

    expect(total).toBe(175);
  });

  test('two requests never share a total', async () => {
    const first = await runWithContext('GET', '/x', async () => {
      recordUpstreamMs(100);
      return upstreamMsSoFar();
    });
    const second = await runWithContext('GET', '/x', async () => upstreamMsSoFar());

    expect(first).toBe(100);
    expect(second).toBe(0);
  });

  test('a nonsense duration is ignored rather than poisoning the total', async () => {
    const total = await runWithContext('GET', '/x', async () => {
      recordUpstreamMs(10);
      recordUpstreamMs(Number.NaN);
      recordUpstreamMs(-5);
      return upstreamMsSoFar();
    });

    expect(total).toBe(10);
  });

  test('outside a request scope it is a no-op, not a throw', () => {
    expect(() => recordUpstreamMs(10)).not.toThrow();
    expect(upstreamMsSoFar()).toBe(0);
  });
});

describe('timeUpstream', () => {
  test('attributes the awaited work and returns its value', async () => {
    const [value, total] = await runWithContext('GET', '/x', async () => {
      const result = await timeUpstream(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 'upstream-said-this';
      });
      return [result, upstreamMsSoFar()] as const;
    });

    expect(value).toBe('upstream-said-this');
    expect(total).toBeGreaterThanOrEqual(20);
  });

  test('a FAILING upstream is still attributed', async () => {
    // A slow upstream that then errors is the case most worth attributing —
    // recording only on success would hide it entirely.
    const total = await runWithContext('GET', '/x', async () => {
      await expect(
        timeUpstream(async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          throw new Error('sandbox unreachable');
        }),
      ).rejects.toThrow('sandbox unreachable');
      return upstreamMsSoFar();
    });

    expect(total).toBeGreaterThanOrEqual(20);
  });
});

describe('upstreamTiming middleware', () => {
  function app() {
    const instance = new Hono();
    instance.use('*', (c, next) => runWithContext('GET', c.req.path, () => next()));
    instance.use('*', upstreamTiming);
    instance.get('/local', (c) => c.json({ ok: true }));
    instance.get('/proxied', async (c) => {
      await timeUpstream(() => new Promise((resolve) => setTimeout(resolve, 40)));
      return c.json({ ok: true });
    });
    return instance;
  }

  test('a route that waits on nothing reports api only', async () => {
    const res = await app().request('/local');
    const timing = parseServerTiming(res.headers.get('server-timing'));

    expect(timing.up).toBeUndefined();
    expect(timing.api).toBeGreaterThanOrEqual(0);
  });

  test('a proxied route splits upstream from the API\'s own work', async () => {
    const res = await app().request('/proxied');
    const timing = parseServerTiming(res.headers.get('server-timing'));

    expect(timing.up).toBeGreaterThanOrEqual(35);
    // The handler does almost nothing besides wait, so the API share must be
    // small — if this ever inverts, the split is measuring the wrong thing.
    expect(timing.api).toBeLessThan(timing.up!);
  });

  test('the API share is never negative', async () => {
    // The two clocks start at different depths of the middleware chain, so
    // rounding can make the subtraction go negative on a nearly-pure-wait
    // request. A negative duration is not valid Server-Timing.
    const instance = new Hono();
    instance.use('*', (c, next) => runWithContext('GET', c.req.path, () => next()));
    instance.use('*', upstreamTiming);
    instance.get('/overstated', (c) => {
      recordUpstreamMs(10_000);
      return c.json({ ok: true });
    });

    const timing = parseServerTiming(
      (await instance.request('/overstated')).headers.get('server-timing'),
    );
    expect(timing.api).toBe(0);
    expect(timing.up).toBe(10_000);
  });
});

import { describe, expect, test } from 'bun:test';
import type { GatewayLogger, UpstreamDescriptor } from '../domain';
import { CircuitBreakers, breakerKey, tripsBreaker } from './circuit-breaker';
import { dispatch } from './dispatch';

const logger: GatewayLogger = { info() {}, warn() {}, error() {} } as unknown as GatewayLogger;
const meta = { provider: 'p', model: 'm', reason: '503', publicListing: true };

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CircuitBreakers', () => {
  test('opens after 5 consecutive failures, skips during the cooldown, then lets exactly one probe through', () => {
    const c = clock();
    const b = new CircuitBreakers({ now: c.now });
    for (let i = 0; i < 4; i++) b.failure('k', meta);
    expect(b.state('k')).toBe('closed');
    b.failure('k', meta);
    expect(b.state('k')).toBe('open');
    expect(b.allow('k')).toBe(false);
    c.advance(30_000);
    expect(b.allow('k')).toBe(true); // the probe
    expect(b.allow('k')).toBe(false); // a concurrent request does not probe too
    b.success('k');
    expect(b.state('k')).toBe('closed');
    expect(b.allow('k')).toBe(true);
  });

  test('a failed probe re-opens with a doubled cooldown, capped at 5 minutes', () => {
    const c = clock();
    const b = new CircuitBreakers({ now: c.now });
    for (let i = 0; i < 5; i++) b.failure('k', meta);
    c.advance(30_000);
    expect(b.allow('k')).toBe(true);
    b.failure('k', meta);
    expect(b.state('k')).toBe('open');
    c.advance(30_000);
    expect(b.allow('k')).toBe(false);
    c.advance(30_000);
    expect(b.allow('k')).toBe(true);
    expect(b.snapshot()[0]!.cooldownMs).toBe(60_000);
  });

  test('a high failure share in the window opens it without 5 in a row', () => {
    const b = new CircuitBreakers({ now: clock().now });
    // Tracking starts at the first failure, so healthy upstreams cost nothing.
    b.failure('k', meta);
    for (let i = 0; i < 4; i++) { b.success('k'); b.failure('k', meta); }
    expect(b.state('k')).toBe('closed'); // 9 outcomes: below the 10-request minimum
    b.success('k'); b.failure('k', meta);
    expect(b.state('k')).toBe('open'); // 11 outcomes, 6 failed
  });

  test('request and credential errors never trip it', () => {
    for (const status of [400, 401, 403, 404, 413, 422]) expect(tripsBreaker(status)).toBe(false);
    for (const status of [undefined, 408, 409, 425, 429, 500, 502, 503, 504]) expect(tripsBreaker(status)).toBe(true);
  });

  test('the public snapshot leaves out circuits of a caller-owned (BYOK) key', () => {
    const b = new CircuitBreakers({ now: clock().now });
    for (let i = 0; i < 5; i++) b.failure('own', { ...meta, publicListing: false });
    for (let i = 0; i < 5; i++) b.failure('managed', meta);
    expect(b.snapshot(true)).toHaveLength(1);
    expect(b.snapshot()).toHaveLength(2);
  });
});

describe('dispatch with an open circuit', () => {
  const upstream = (name: string): UpstreamDescriptor => ({
    provider: name, kind: 'openai-compat', baseUrl: `https://${name}.test/v1`, apiKey: `${name}-key`,
    billingMode: 'none', markup: 0, resolvedModel: name === 'a' ? 'model-a' : 'model-b',
  } as UpstreamDescriptor);
  const ok = () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

  test('skips the failing upstream with zero attempts and serves from the fallback model', async () => {
    const breakers = new CircuitBreakers({ now: clock().now });
    const a = upstream('a');
    for (let i = 0; i < 5; i++) breakers.failure(breakerKey(a, 'model-a'), meta);
    const hits: string[] = [];
    const outcome = await dispatch(
      { model: 'model-a', messages: [] },
      { model: 'model-a', candidates: [a], fallbackModels: ['model-b'], fallbackOn: 'transient' } as never,
      {
        requestId: 'r', logger, breakers,
        fetchImpl: async (url: string) => { hits.push(new URL(url).host); return ok(); },
        resolveCandidates: async () => [upstream('b')],
      },
    );
    expect('response' in outcome && outcome.response?.status).toBe(200);
    expect(hits).toEqual(['b.test']);
    expect(outcome.attempts).toBe(1);
    expect(outcome.attemptFailures[0]).toMatchObject({ code: 'circuit_open', provider: 'a' });
  });

  test('with nothing else to try, an open upstream is still tried', async () => {
    const breakers = new CircuitBreakers({ now: clock().now });
    const a = upstream('a');
    for (let i = 0; i < 5; i++) breakers.failure(breakerKey(a, 'model-a'), meta);
    const hits: string[] = [];
    const outcome = await dispatch(
      { model: 'model-a', messages: [] },
      { model: 'model-a', candidates: [a], fallbackModels: [] } as never,
      { requestId: 'r', logger, breakers, fetchImpl: async (url: string) => { hits.push(new URL(url).host); return ok(); }, resolveCandidates: async () => [] },
    );
    expect('response' in outcome && outcome.response?.status).toBe(200);
    expect(hits).toEqual(['a.test']);
    expect(breakers.state(breakerKey(a, 'model-a'))).toBe('closed');
  });

  test('repeated 503s open the circuit for the next request; a 400 never does', async () => {
    const breakers = new CircuitBreakers({ now: clock().now });
    const a = upstream('a');
    const run = (status: number) => dispatch(
      { model: 'model-a', messages: [] },
      { model: 'model-a', candidates: [a], fallbackModels: [] } as never,
      { requestId: 'r', logger, breakers, fetchImpl: async () => new Response('{}', { status }), resolveCandidates: async () => [] },
    );
    for (let i = 0; i < 6; i++) await run(400);
    expect(breakers.state(breakerKey(a, 'model-a'))).toBe('closed');
    for (let i = 0; i < 5; i++) await run(503);
    expect(breakers.state(breakerKey(a, 'model-a'))).toBe('open');
  });
});

describe('the half-open probe always ends', () => {
  const upstream = (name: string): UpstreamDescriptor => ({
    provider: name, kind: 'openai-compat', baseUrl: `https://${name}.test/v1`, apiKey: `${name}-key`,
    billingMode: 'none', markup: 0, resolvedModel: `model-${name}`,
  } as UpstreamDescriptor);
  const ok = () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

  /** Trips `a`, waits out its cooldown, and returns the probe-ready breakers. */
  function trippedPastCooldown() {
    const c = clock();
    const breakers = new CircuitBreakers({ now: c.now });
    const a = upstream('a');
    const key = breakerKey(a, 'model-a');
    for (let i = 0; i < 5; i++) breakers.failure(key, meta);
    c.advance(30_000);
    return { c, breakers, a, key };
  }
  const plan = (a: UpstreamDescriptor) => ({ model: 'model-a', candidates: [a], fallbackModels: ['model-b'], fallbackOn: 'transient' } as never);

  test('a client abort during the probe releases it: the next request probes and closes the circuit', async () => {
    const { breakers, a, key } = trippedPastCooldown();
    const client = new AbortController();
    const hits: string[] = [];
    await dispatch({ model: 'model-a', messages: [] }, plan(a), {
      requestId: 'probe', logger, breakers, signal: client.signal,
      fetchImpl: async (url: string) => {
        hits.push(new URL(url).host);
        client.abort(); // the user pressed Stop while the probe was in flight
        throw new DOMException('aborted', 'AbortError');
      },
      resolveCandidates: async () => [upstream('b')],
    });
    expect(hits).toEqual(['a.test']); // the aborted request was the probe
    expect(breakers.state(key)).toBe('half_open');

    const next: string[] = [];
    const outcome = await dispatch({ model: 'model-a', messages: [] }, plan(a), {
      requestId: 'next', logger, breakers,
      fetchImpl: async (url: string) => { next.push(new URL(url).host); return ok(); },
      resolveCandidates: async () => [upstream('b')],
    });
    expect('response' in outcome && outcome.response?.status).toBe(200);
    expect(next).toEqual(['a.test']); // probed again instead of skipping to the fallback
    expect(breakers.state(key)).toBe('closed');
  });

  test('a non-tripping 4xx probe releases it without closing or re-opening', async () => {
    const { breakers, a, key } = trippedPastCooldown();
    await dispatch({ model: 'model-a', messages: [] }, { model: 'model-a', candidates: [a], fallbackModels: [] } as never, {
      requestId: 'probe', logger, breakers,
      fetchImpl: async () => new Response('{"error":"bad"}', { status: 400 }),
      resolveCandidates: async () => [],
    });
    expect(breakers.state(key)).toBe('half_open');
    expect(breakers.allow(key)).toBe(true); // the next caller is the probe
  });

  test('a success from a request admitted before the circuit opened does not close it', () => {
    const c = clock();
    const b = new CircuitBreakers({ now: c.now });
    const admittedAt = c.now();
    c.advance(1_000);
    for (let i = 0; i < 5; i++) b.failure('k', meta);
    b.success('k', admittedAt); // slow in-flight request answers late
    expect(b.state('k')).toBe('open');
    c.advance(30_000);
    expect(b.allow('k')).toBe(true);
    b.success('k', c.now());
    expect(b.state('k')).toBe('closed');
  });
});

describe('real upstream on a port: a client abort during the half-open probe', () => {
  test('trips on 503s, the probe is aborted by the client, the next request probes again and closes the circuit', async () => {
    let mode: 'fail' | 'hang' | 'ok' = 'fail';
    const seen: string[] = [];
    let probeArrived!: () => void;
    const probeReached = new Promise<void>((resolve) => { probeArrived = resolve; });
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push(mode);
        if (mode === 'fail') return new Response('{"error":{"message":"down"}}', { status: 503 });
        if (mode === 'hang') {
          probeArrived();
          // Holds the probe until the client goes away.
          await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve()));
          return new Response('late', { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    });
    try {
      const c = clock();
      const breakers = new CircuitBreakers({ now: c.now });
      const a = {
        provider: 'real', kind: 'openai-compat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k',
        billingMode: 'none', markup: 0, resolvedModel: 'model-real',
      } as UpstreamDescriptor;
      const key = breakerKey(a, 'model-real');
      const call = (signal?: AbortSignal) => dispatch(
        { model: 'model-real', messages: [{ role: 'user', content: 'hi' }] },
        { model: 'model-real', candidates: [a], fallbackModels: [] } as never,
        { requestId: 'real', logger, breakers, signal, fetchImpl: fetch, resolveCandidates: async () => [] },
      );
      for (let i = 0; i < 5; i++) await call();
      expect(breakers.state(key)).toBe('open');

      c.advance(30_000); // cooldown passes on the injected clock
      mode = 'hang';
      const client = new AbortController();
      const probe = call(client.signal);
      await probeReached;
      client.abort(); // Stop pressed during the probe
      await probe;
      expect(breakers.state(key)).toBe('half_open');
      expect(breakers.allow(key)).toBe(true); // released: the next caller is the probe
      breakers.release(key);

      mode = 'ok';
      const next = await call();
      expect('response' in next && next.response?.status).toBe(200);
      expect(breakers.state(key)).toBe('closed');
      expect(seen).toEqual(['fail', 'fail', 'fail', 'fail', 'fail', 'hang', 'ok']);
    } finally {
      server.stop(true);
    }
  });
});

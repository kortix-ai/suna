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

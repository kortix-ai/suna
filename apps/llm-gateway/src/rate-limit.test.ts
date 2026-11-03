import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createTokenRateLimit } from './token-rate-limit';

afterEach(() => setSystemTime());

test('credential limits expose counters and retry metadata across gateway aliases', () => {
  setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const limit = createTokenRateLimit(2);
  const request = (path: string) => new Request(`https://gateway.test${path}`, {
    headers: { authorization: 'Bearer synthetic-credential' },
  });
  const headers = new Headers();
  expect(limit(request('/v1/models'), headers)).toBeNull();
  expect(headers.get('RateLimit-Limit')).toBe('2');
  expect(headers.get('RateLimit-Remaining')).toBe('1');
  expect(headers.get('RateLimit-Reset')).toBe('30');
  expect(limit(request('/models'))).toBeNull();
  const denied = limit(request('/v1/responses'));
  expect(denied?.status).toBe(429);
  expect(denied?.headers.get('Retry-After')).toBe('30');
  expect(denied?.headers.get('RateLimit-Remaining')).toBe('0');
  expect(denied?.headers.get('RateLimit-Reset')).toBe('60');
  setSystemTime(new Date('2026-01-01T00:00:30Z'));
  expect(limit(request('/v1/messages'), headers)).toBeNull();
  expect(headers.get('RateLimit-Remaining')).toBe('0');
});

test('registered model routes return counters and reject before the gateway call', async () => {
  process.env.KORTIX_API_URL ??= 'https://api.test.invalid';
  process.env.GATEWAY_INTERNAL_TOKEN ??= 'synthetic-internal-token';
  const { Hono } = await import('hono');
  const { InflightBudget } = await import('@kortix/llm-gateway');
  const { registerRoutes } = await import('./routes');
  const app = new Hono();
  let calls = 0;
  const reply = async () => { calls++; return Response.json({ data: [] }); };
  registerRoutes(app, {
    chatCompletions: reply, messages: reply, responses: reply,
    listModels: reply, images: reply, audio: reply, voices: reply, claudeCode: reply,
  }, new InflightBudget({ maxBytes: 1024, perRequestMaxBytes: 1024, amplification: 1 }),
  () => {}, createTokenRateLimit(1));
  const headers = { authorization: 'Bearer synthetic-route-credential' };
  const allowed = await app.request('/v1/models', { headers });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('RateLimit-Limit')).toBe('1');
  expect(allowed.headers.get('RateLimit-Remaining')).toBe('0');
  const denied = await app.request('/models', { headers });
  expect(denied.status).toBe(429);
  expect(denied.headers.get('RateLimit-Limit')).toBe('1');
  expect(denied.headers.get('Retry-After')).not.toBeNull();
  expect(calls).toBe(1);
});

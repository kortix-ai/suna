import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { headlessAuthRouter } from '../http/auth/headless';
import { __setGoTrueFetch } from '../services/auth/gotrue';

// The db-suites runner supplies a migrated, isolated PostgreSQL database.
const token = randomUUID();
const app = new Hono();
app.route('/v1/auth', headlessAuthRouter);
let upstreamCalls = 0;
__setGoTrueFetch(async () => {
  upstreamCalls++;
  return Response.json({
    access_token: 'synthetic-access', refresh_token: 'synthetic-rotated',
    token_type: 'bearer', expires_in: 3600, expires_at: 1790000000,
    user: { id: randomUUID(), email: 'synthetic@example.test' },
  });
});

afterAll(() => __setGoTrueFetch(null));

const refresh = () => app.request('/v1/auth/refresh', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.7' },
  body: JSON.stringify({ refresh_token: token }),
});

describe('refresh replay through the HTTP handler with PostgreSQL', () => {
  test('one concurrent request rotates; the rest and a later replay are rejected', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, refresh));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400, 400, 400, 400, 400, 400, 400]);
    expect(upstreamCalls).toBe(1);
    const accepted = responses.find((response) => response.status === 200);
    expect((await accepted?.json())?.session?.refresh_token).toBe('synthetic-rotated');
    const replay = await refresh();
    expect(replay.status).toBe(400);
    expect(upstreamCalls).toBe(1);
  });
});

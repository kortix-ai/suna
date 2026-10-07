import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resetAiIndexRateLimitsForTests } from '@/lib/seo/rate-limit';

import { POST } from './route';

const realFetch = globalThis.fetch;
let inserted: unknown[] = [];

beforeEach(() => {
  resetAiIndexRateLimitsForTests();
  inserted = [];
  process.env.SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('supabase.test') && init?.body) inserted.push(JSON.parse(String(init.body)));
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function post(body: string, ip = '203.0.113.1') {
  return POST(
    new Request('http://localhost/api/demo-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body,
    }) as never,
  );
}

describe('POST /api/demo-request', () => {
  test('refuses a body over 8 KB', async () => {
    const res = await post(JSON.stringify({ email: 'a@b.co', goal: 'x'.repeat(9000) }));
    expect(res.status).toBe(413);
    expect(inserted).toEqual([]);
  });

  test('stores only the known fields, truncated', async () => {
    const res = await post(
      JSON.stringify({ email: 'a@b.co', goal: 'g'.repeat(5000), junk: { a: 1 }, form: 'forged' }),
    );
    expect(res.status).toBe(200);
    const row = (inserted[0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(row).sort()).toEqual(['email', 'form', 'goal', 'user_agent']);
    expect(row.form).toBe('contact');
    expect((row.goal as string).length).toBe(2000);
  });

  test('limits one address to 5 submissions a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post(JSON.stringify({ email: 'a@b.co' }))).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await post(JSON.stringify({ email: 'a@b.co' }), '203.0.113.9')).status).toBe(200);
  });
});

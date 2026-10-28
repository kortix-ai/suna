import { afterEach, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({ config: {
  SUPABASE_URL: 'https://auth.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key',
} }));
const { gotrue, gotrueAuthorizeUrl, __setGoTrueFetch } = await import('../auth/gotrue');
afterEach(() => __setGoTrueFetch(null));

for (const [label, body, expected] of [
  ['JSON', '{"code":"invalid","msg":"denied"}', { error: 'invalid', error_description: 'denied' }],
  ['invalid JSON', 'not json', { error: 'auth_error', error_description: 'Authentication request failed (400)' }],
  ['empty', '', { error: 'auth_error', error_description: 'Authentication request failed (400)' }],
] as const) {
  test(`${label} error decoding is identical for regular and authorize calls`, async () => {
    __setGoTrueFetch(async () => new Response(body, { status: 400 }));
    expect<unknown>(await gotrue('/user')).toEqual({ ok: false, status: 400, body: expected });
    expect<unknown>(await gotrueAuthorizeUrl({})).toEqual({ ok: false, status: 400, body: expected });
  });
}

test('successful JSON, invalid JSON and empty responses retain their body shape', async () => {
  for (const [body, expected] of [['{"id":"synthetic"}', { id: 'synthetic' }], ['raw', 'raw'], ['', {}]]) {
    __setGoTrueFetch(async () => new Response(String(body)));
    expect<unknown>(await gotrue('/user')).toEqual({ ok: true, status: 200, body: expected });
    expect<unknown>(await gotrueAuthorizeUrl({})).toEqual({ ok: false, status: 502, body: {
      error: 'auth_error', error_description: 'Authentication request failed (200)',
    } });
  }
});

test('a rejected body read falls back to an empty body', async () => {
  __setGoTrueFetch(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('read failed')); },
  })));
  expect<unknown>(await gotrue('/user')).toEqual({ ok: true, status: 200, body: {} });
  expect<unknown>(await gotrueAuthorizeUrl({})).toEqual({ ok: false, status: 502, body: {
    error: 'auth_error', error_description: 'Authentication request failed (200)',
  } });
});

for (const status of [301, 302, 303]) {
  test(`authorize ${status} returns Location without reading its body`, async () => {
    __setGoTrueFetch(async () => new Response(new ReadableStream({
      pull() { throw new Error('redirect body must not be read'); },
    }), { status, headers: { location: 'https://provider.example.test/authorize' } }));
    expect<unknown>(await gotrueAuthorizeUrl({})).toEqual({ ok: true, status: 200, body: {
      url: 'https://provider.example.test/authorize',
    } });
  });
}

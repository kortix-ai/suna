import { beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import { compareSemver, getMobileClientPolicy } from './client-policy';

describe('compareSemver', () => {
  test.each([
    ['1.5.0', '1.5.0', 0],
    ['1.5.0', '1.6.0', -1],
    ['1.10.0', '1.9.9', 1],
    ['2.0.0', '1.99.99', 1],
    ['1.5.1', '1.5.0', 1],
    ['1.5', '1.5.0', 0],
    ['v1.5.0', '1.5.0', 0],
    ['V1.4.9', 'v1.5.0', -1],
    ['1.5.0-beta.2', '1.5.0', 0],
    ['1.5.0+build.7', '1.5.0', 0],
    [' 1.5.0 ', '1.5.0', 0],
  ] as const)('%s vs %s = %d', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });

  test.each([['', '1.0.0'], ['abc', '1.0.0'], ['1.0.0', 'x.y.z'], ['1.0.0.0', '1.0.0'], ['-1.0.0', '1.0.0']])(
    'unparsable %p vs %p = null',
    (a, b) => {
      expect(compareSemver(a, b)).toBeNull();
    },
  );
});

describe('getMobileClientPolicy', () => {
  let calls: { url: string; auth: string | null }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeEach(() => {
    calls = [];
    configureKortix({
      backendUrl: 'http://backend.test',
      getToken: async () => null,
      fetch: async (input, init) => {
        calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify(reply.body), { status: reply.status });
      },
    });
  });

  test('GETs /v1/clients/mobile with no token, before login', async () => {
    const policy = { minimum_version: '1.6.0', store_url_ios: 'https://s.test/ios', store_url_android: null };
    reply = { status: 200, body: policy };
    expect(await getMobileClientPolicy()).toEqual(policy);
    expect(calls).toEqual([{ url: 'http://backend.test/v1/clients/mobile', auth: null }]);
  });

  test('a non-200 answer throws an ApiError carrying the status', async () => {
    reply = { status: 503, body: { error: 'down' } };
    const error = await getMobileClientPolicy().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
  });
});

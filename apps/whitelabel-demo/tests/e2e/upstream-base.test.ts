import { afterAll, describe, expect, test } from 'bun:test';
import { upstreamBase } from '../../src/server/upstream-path';

/**
 * The ONE documented upstream variable, `KORTIX_UPSTREAM`. Routes that each
 * read their own variable 404'd whole features before; this file pins the
 * single chain so it cannot drift again.
 */
describe('upstreamBase — the one documented env chain', () => {
  const saved = new Map<string, string | undefined>();
  const setEnv = (name: string, value: string | undefined) => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('KORTIX_UPSTREAM wins and loses its trailing slashes', () => {
    setEnv('KORTIX_UPSTREAM', 'https://upstream.example/v1///');
    setEnv('NEXT_PUBLIC_KORTIX_API_URL', 'https://public.example/v1');
    setEnv('KORTIX_API_URL', 'https://undocumented.example/v1');
    expect(upstreamBase()).toBe('https://upstream.example/v1');
  });

  test('with neither set, the public Kortix api is the default', () => {
    setEnv('KORTIX_UPSTREAM', undefined);
    expect(upstreamBase()).toBe('https://api.kortix.com/v1');
  });

  test('the undocumented KORTIX_API_URL is never honored', () => {
    // The 404 incident: a chain that reads this variable sends wrapper traffic
    // somewhere the documented setup never configured.
    setEnv('KORTIX_UPSTREAM', undefined);
    setEnv('NEXT_PUBLIC_KORTIX_API_URL', undefined);
    setEnv('KORTIX_API_URL', 'https://undocumented.example/v1');
    expect(upstreamBase()).toBe('https://api.kortix.com/v1');
  });
});

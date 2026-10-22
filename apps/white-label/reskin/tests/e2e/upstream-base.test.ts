import { afterAll, describe, expect, test } from 'bun:test';
import { upstreamBase } from '../../src/server/upstream-path';

/**
 * The ONE documented upstream env chain, pinned per env combination.
 *
 * Every server route used to carry its own `upstreamBase()` with three
 * different fallback chains; two of them 404'd whole features on deployments
 * that set only the documented variable (the in-tree incident comments in the
 * old copies record it). One function in `src/server/upstream-path.ts` owns
 * the chain now, and this file pins it so the chains cannot drift apart again:
 *
 * - `KORTIX_UPSTREAM` — the documented wrapper-mode upstream (`.env.example`),
 *   always first.
 * - `NEXT_PUBLIC_KORTIX_API_URL` — the documented direct-mode origin. The only
 *   server route that also serves direct mode (`/api/preview-url`) must reach
 *   the same origin the browser was given.
 * - `KORTIX_API_URL` — undocumented, and reading it is the 404 incident: a
 *   chain that honors it silently bypasses the documented setup. Never honored.
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

  test('direct mode falls back to NEXT_PUBLIC_KORTIX_API_URL', () => {
    setEnv('KORTIX_UPSTREAM', undefined);
    setEnv('NEXT_PUBLIC_KORTIX_API_URL', 'https://direct.example/v1');
    expect(upstreamBase()).toBe('https://direct.example/v1');
  });

  test('with neither set, the public Kortix api is the default', () => {
    setEnv('KORTIX_UPSTREAM', undefined);
    setEnv('NEXT_PUBLIC_KORTIX_API_URL', undefined);
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

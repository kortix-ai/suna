/**
 * Mode bootstrap + the auth-gate the client picks based on it.
 *
 * NOTE on "UI gate" testing: `src/app/page.tsx` and `src/app/providers.tsx`
 * are Client Components whose FIRST render (before any `useEffect` runs) is
 * always the loading spinner — `wrapperMode === null` / `ready === null`.
 * Next prerenders that exact first-pass tree on the server, so a plain
 * `fetch('/')` returns the SAME loading-shell HTML in both modes; the actual
 * `LoginGate` vs `ApiKeyGate` choice only happens client-side, after
 * hydration reads `GET /api/mode` (see `providers.tsx`). We verified this
 * empirically (both modes render only the spinner markup, never gate text).
 *
 * So the deterministic, HTTP-level equivalent of "which gate renders" IS
 * `GET /api/mode` — it's the one signal `useWrapperMode()` depends on. These
 * tests assert that signal per mode, plus that `/` itself boots (200, right
 * `<title>`, the shared loading shell) in both configurations.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppInstance, startApp } from './harness';
import { wrapperEnv } from './env';

describe('mode bootstrap', () => {
  let wrapperApp: AppInstance;
  let directApp: AppInstance;

  beforeAll(async () => {
    [wrapperApp, directApp] = await Promise.all([
      startApp(wrapperEnv()),
      startApp({ KORTIX_API_KEY: undefined, NEXT_PUBLIC_KORTIX_API_URL: 'https://direct.example/v1' }),
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([wrapperApp?.stop(), directApp?.stop()]);
  });

  test('GET /api/mode reports wrapperMode: true when KORTIX_API_KEY is set', async () => {
    const res = await fetch(`${wrapperApp.baseUrl}/api/mode`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrapperMode: true });
  });

  test('GET /api/mode reports wrapperMode: false when KORTIX_API_KEY is unset (direct mode)', async () => {
    const res = await fetch(`${directApp.baseUrl}/api/mode`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrapperMode: false });
  });

  test('wrapper mode: / serves the shared app shell (login gate mounts client-side off /api/mode)', async () => {
    const res = await fetch(`${wrapperApp.baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Lumen</title>');
    expect(html).toContain('animate-spin'); // the pre-hydration loading shell
  });

  test('direct mode: / serves the shared app shell (API-key gate mounts client-side off /api/mode)', async () => {
    const res = await fetch(`${directApp.baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Lumen</title>');
    expect(html).toContain('animate-spin');
  });

  test('wrapper mode: proxy is enabled (500 only for missing session, not missing key)', async () => {
    // Sanity: confirms this boot really is wrapper mode end-to-end, not just
    // /api/mode lying — an unauthenticated proxy call should 401, never the
    // 500 "wrapper mode is not enabled" branch.
    const res = await fetch(`${wrapperApp.baseUrl}/api/kortix/projects`);
    expect(res.status).toBe(401);
  });

  test('direct mode: proxy route reports wrapper mode is not enabled', async () => {
    const res = await fetch(`${directApp.baseUrl}/api/kortix/projects`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Wrapper mode is not enabled on this server (KORTIX_API_KEY is unset).',
    });
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from './route';

// GitHub is stubbed: the suite asserts the redirect, not GitHub's latency. A
// live call timed out the packages and core lanes at bun's 5 s default.
const realFetch = globalThis.fetch;
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/kortix-ai/suna/releases/download/v1.0.0/${name}`,
  size: 1,
});
const release = {
  tag_name: 'v1.0.0',
  assets: [asset('Kortix-1.0.0-universal.dmg'), asset('Kortix-Setup-1.0.0.exe'), asset('Kortix-1.0.0-x86_64.AppImage')],
};
let githubFetch: typeof fetch;
beforeEach(() => {
  githubFetch = (async () => Response.json(release)) as unknown as typeof fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => githubFetch(input, init)) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (platform: string) =>
  GET(new NextRequest(`https://kortix.com/download/${platform}`), {
    params: Promise.resolve({ platform }),
  });

describe('GET /download/<platform>', () => {
  test('302s every known platform to a real installer asset', async () => {
    for (const [platform, suffix] of [
      ['macos', '.dmg'],
      ['windows', '.exe'],
      ['linux', '.AppImage'],
    ] as const) {
      const res = await call(platform);
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toEndWith(suffix);
    }
  });

  test('falls back to the releases page when GitHub does not answer', async () => {
    // A request that only ends when its signal aborts: without a fetch
    // timeout, the visitor's download click hangs with it.
    githubFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const res = await call('macos');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/releases/latest');
  });

  test('accepts the aliases old links used', async () => {
    for (const alias of ['mac', 'darwin', 'win']) {
      expect((await call(alias)).status).toBe(302);
    }
  });

  test('falls back to the releases page for an unknown platform', async () => {
    const res = await call('solaris');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/releases/latest');
  });

  test('never hands a phone a desktop installer', async () => {
    // normalizePlatform resolves these to real platforms, so without the mobile
    // guard they reach pickDesktopAsset, whose isInstaller() falls through to
    // `.appimage` for anything that is not macOS or Windows. That would serve a
    // Linux AppImage to an iPhone.
    for (const platform of ['ios', 'iphone', 'ipad', 'android']) {
      const res = await call(platform);
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('/releases/latest');
      expect(location.toLowerCase()).not.toContain('.appimage');
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from './route';

// GitHub is stubbed: the suite asserts the redirect, not GitHub's latency.
const realFetch = globalThis.fetch;
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/kortix-ai/suna/releases/download/v1.0.0/${name}`,
  size: 1,
});
let assets = [
  asset('Kortix-1.0.0-universal.dmg'),
  asset('Kortix-Setup-1.0.0.exe'),
  asset('KortixCapture-x64.msi'),
  asset('KortixCapture-universal.pkg'),
  asset('kortix-capture_amd64.deb'),
];
beforeEach(() => {
  // The Releases list: a newer Kortix release without Capture installers (skipped) and the one that has them.
  globalThis.fetch = (async () =>
    Response.json([
      { tag_name: 'v1.0.1', draft: false, assets: [asset('Kortix-Setup-1.0.1.exe')] },
      { tag_name: 'v1.0.0', draft: false, assets },
    ])) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (platform: string) =>
  GET(new NextRequest(`https://kortix.com/download/capture/${platform}`), { params: Promise.resolve({ platform }) });

describe('GET /download/capture/<platform>', () => {
  test('302s each OS to its Kortix Capture installer, never the Kortix app', async () => {
    for (const [platform, name] of [
      ['windows', 'KortixCapture-x64.msi'],
      ['macos', 'KortixCapture-universal.pkg'],
      ['linux', 'kortix-capture_amd64.deb'],
    ] as const) {
      const res = await call(platform);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')?.endsWith(`/${name}`)).toBe(true);
    }
  });

  test('a release without Capture installers, or an unknown platform, lands on the install docs', async () => {
    assets = [asset('Kortix-1.0.0-universal.dmg')];
    for (const platform of ['windows', 'beos', 'ios']) {
      const res = await call(platform);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/docs/capture#install-kortix-capture');
    }
  });

  test('the docs fallback never names the internal host the request arrived on', async () => {
    assets = [asset('Kortix-1.0.0-universal.dmg')];
    const res = await GET(
      new NextRequest('http://ip-10-14-146-154.us-east-2.compute.internal:3000/download/capture/macos'),
      { params: Promise.resolve({ platform: 'macos' }) },
    );
    expect(res.headers.get('location')).toBe('/docs/capture#install-kortix-capture');
  });

  test('the dev deployment (backend dev-api) serves the capture-dev-latest build', async () => {
    const backend = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = 'https://dev-api.kortix.com/v1';
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return Response.json({
        name: 'Kortix Capture 0.13.58-dev.33',
        tag_name: 'capture-dev-latest',
        assets: [{ name: 'KortixCapture-universal.pkg', browser_download_url: 'https://github.com/kortix-ai/suna/releases/download/capture-dev-latest/KortixCapture-universal.pkg', size: 1 }],
      });
    }) as unknown as typeof fetch;
    try {
      const res = await call('macos');
      expect(res.headers.get('location')).toBe('https://github.com/kortix-ai/suna/releases/download/capture-dev-latest/KortixCapture-universal.pkg');
      expect(urls.some((u) => u.endsWith('/releases/tags/capture-dev-latest'))).toBe(true);
    } finally {
      if (backend === undefined) delete process.env.NEXT_PUBLIC_BACKEND_URL;
      else process.env.NEXT_PUBLIC_BACKEND_URL = backend;
    }
  });
});

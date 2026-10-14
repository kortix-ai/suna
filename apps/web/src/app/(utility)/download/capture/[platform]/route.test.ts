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
      expect(new URL(res.headers.get('location')!).pathname).toBe('/docs/capture');
      expect(new URL(res.headers.get('location')!).hash).toBe('#install-kortix-capture');
    }
  });
});

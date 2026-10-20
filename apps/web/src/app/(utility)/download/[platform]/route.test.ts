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

describe('GET /download/<platform> per deployment', () => {
  const withBackend = async (backend: string, run: () => Promise<void>) => {
    const saved = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = backend;
    try {
      await run();
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_BACKEND_URL;
      else process.env.NEXT_PUBLIC_BACKEND_URL = saved;
    }
  };

  for (const channel of ['dev', 'staging'] as const) {
    test(`the ${channel} deployment serves the newest desktop-${channel}-latest build`, async () => {
      const urls: string[] = [];
      githubFetch = (async (url: RequestInfo | URL) => {
        urls.push(String(url));
        return Response.json({
          tag_name: `desktop-${channel}-latest`,
          assets: [asset('Kortix-0.9.83-universal.dmg'), asset('Kortix.Dev-0.14.3-universal.dmg'), asset('Kortix.Dev-0.13.51-universal.dmg')],
        });
      }) as unknown as typeof fetch;
      await withBackend(`https://${channel}-api.kortix.com/v1`, async () => {
        const res = await call('macos');
        expect(res.headers.get('location') ?? '').toEndWith('/Kortix.Dev-0.14.3-universal.dmg');
        expect(urls).toEqual([`https://api.github.com/repos/kortix-ai/suna/releases/tags/desktop-${channel}-latest`]);
      });
    });

    test(`the ${channel} deployment never falls back to the production installer`, async () => {
      githubFetch = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
      await withBackend(`https://${channel}-api.kortix.com/v1`, async () => {
        const res = await call('windows');
        expect(res.headers.get('location')).toBe(`https://github.com/kortix-ai/suna/releases/tag/desktop-${channel}-latest`);
      });
    });
  }

  test('production serves the latest vX.Y.Z release', async () => {
    const urls: string[] = [];
    githubFetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json(release);
    }) as unknown as typeof fetch;
    await withBackend('https://api.kortix.com/v1', async () => {
      expect((await call('linux')).headers.get('location') ?? '').toEndWith('/Kortix-1.0.0-x86_64.AppImage');
      expect(urls).toEqual(['https://api.github.com/repos/kortix-ai/suna/releases/latest']);
    });
  });
});

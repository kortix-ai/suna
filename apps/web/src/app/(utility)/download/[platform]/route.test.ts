import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from './route';

const call = (platform: string) =>
  GET(new NextRequest(`https://dosco.live/download/${platform}`), {
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
      const location = res.headers.get('location') ?? '';
      // Either the resolved asset, or the releases page if GitHub was unreachable.
      expect(location.endsWith(suffix) || location.includes('/releases/latest')).toBe(true);
    }
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

import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from './route';

const call = (platform: string, host = 'kortix.com') =>
  GET(new NextRequest(`https://${host}/download/${platform}`, { headers: { host } }), {
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

/* ── Per-host channel routing ────────────────────────────────────────────
   Three desktop builds install side by side, so each host must serve its own.
   These assert the RELEASE the redirect points into, which holds whether the
   asset resolved or GitHub was unreachable and we fell back to the tag page. */

describe('channel routing by host', () => {
  test('dev.kortix.com serves the dev build', async () => {
    const res = await call('macos', 'dev.kortix.com');
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('desktop-dev-latest');
  });

  test('staging.kortix.com serves the staging build', async () => {
    const res = await call('macos', 'staging.kortix.com');
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('desktop-staging-latest');
  });

  // The regression this whole change exists to prevent: a prerelease installer
  // must never reach a production visitor.
  test('a production host never serves a prerelease build', async () => {
    for (const host of ['kortix.com', 'www.kortix.com', 'kortix.example.com']) {
      const res = await call('macos', host);
      const location = res.headers.get('location') ?? '';
      expect(location).not.toContain('desktop-dev-latest');
      expect(location).not.toContain('desktop-staging-latest');
    }
  });

  // The unresolvable paths must stay on the visitor's own channel too —
  // bouncing a dev visitor to the production releases page would quietly hand
  // them the prod installer.
  test('an unknown platform falls back within the same channel', async () => {
    const res = await call('solaris', 'dev.kortix.com');
    expect(res.headers.get('location') ?? '').toContain('desktop-dev-latest');
  });

  test('a phone on the dev host still gets no desktop installer', async () => {
    const res = await call('ios', 'dev.kortix.com');
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('desktop-dev-latest');
    expect(location.toLowerCase()).not.toContain('.appimage');
    expect(location.toLowerCase()).not.toContain('.dmg');
  });
});

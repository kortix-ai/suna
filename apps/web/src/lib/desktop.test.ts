import { afterEach, describe, expect, test } from 'bun:test';

import { buildDesktopDeepLink } from '@/lib/auth/desktop-bounce';
import {
  DESKTOP_BASE_ZOOM,
  authRedirectUrl,
  desktopPlatform,
  desktopUrlScheme,
  desktopShellPlatform,
  getDesktopZoom,
  isDesktop,
  openExternalRoute,
  setDesktopZoom,
  zoomReset,
} from '@/lib/desktop';

const originalNavigator = globalThis.navigator;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function setNavigator(userAgent: string, platform: string) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent, platform },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: originalDocument,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
    writable: true,
  });
});

describe('desktop external routes', () => {
  test('routes each legal page through a real top-level navigation on desktop', () => {
    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0', 'MacIntel');
    const clicks: Array<{ href: string; target?: string; rel?: string }> = [];
    const anchor = {
      href: '',
      target: undefined as string | undefined,
      rel: undefined as string | undefined,
      click() {
        clicks.push({ href: this.href, target: this.target, rel: this.rel });
      },
      remove() {},
    };
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://kortix.com' } },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement: () => anchor,
        body: { appendChild() {} },
      },
      configurable: true,
      writable: true,
    });

    expect(openExternalRoute('/legal/terms')).toBe(true);
    expect(openExternalRoute('/legal?tab=privacy')).toBe(true);
    expect(clicks).toEqual([
      { href: 'https://kortix.com/legal/terms', target: undefined, rel: undefined },
      { href: 'https://kortix.com/legal?tab=privacy', target: undefined, rel: undefined },
    ]);
  });

  test('leaves legal navigation to Next.js in a regular browser', () => {
    setNavigator('Mozilla/5.0 Safari/605.1.15', 'MacIntel');
    expect(openExternalRoute('/legal/terms')).toBe(false);
  });
});

describe('desktop shell detection', () => {
  test('plain browser UA is not desktop', () => {
    setNavigator('Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36', 'MacIntel');
    expect(isDesktop()).toBe(false);
    expect(desktopPlatform()).toBeNull();
    expect(desktopShellPlatform()).toBeNull();
  });

  test('KortixDesktop UA on a Mac resolves to macos', () => {
    setNavigator('Mozilla/5.0 Chrome/130 Safari/537.36 KortixDesktop/0.1.0', 'MacIntel');
    expect(isDesktop()).toBe(true);
    expect(desktopPlatform()).toBe('macos');
    expect(desktopShellPlatform()).toBe('macos');
  });

  test('KortixDesktop UA on Windows buckets as other', () => {
    setNavigator('Mozilla/5.0 Chrome/130 Safari/537.36 KortixDesktop/0.1.0', 'Win32');
    expect(desktopPlatform()).toBe('windows');
    expect(desktopShellPlatform()).toBe('other');
  });

  test('KortixDesktop UA on Linux buckets as other', () => {
    setNavigator('Mozilla/5.0 Chrome/130 Safari/537.36 KortixDesktop/0.1.0', 'Linux x86_64');
    expect(desktopPlatform()).toBe('linux');
    expect(desktopShellPlatform()).toBe('other');
  });

  test('unknown platform string under the desktop UA falls back to linux/other', () => {
    setNavigator('KortixDesktop/0.1.0', '');
    expect(desktopPlatform()).toBe('linux');
    expect(desktopShellPlatform()).toBe('other');
  });
});

/**
 * The shell renders the page smaller than a browser tab does, and the user can
 * still move it with Cmd+/Cmd-. A stored zoom is an ABSOLUTE factor, so it only
 * means anything against the base it was chosen for — the stamp is what lets
 * DESKTOP_BASE_ZOOM be changed at all.
 *
 * Without it, `getDesktopZoom` returns the old absolute value forever and
 * editing the constant is a silent no-op for anyone who ever touched the zoom
 * keys. That is not hypothetical: it happened on the 0.9 rollout.
 */
describe('desktop zoom persistence', () => {
  function setStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
        },
      },
      configurable: true,
      writable: true,
    });
    return store;
  }

  test('with nothing stored, the shell default applies', () => {
    setStorage();
    expect(getDesktopZoom()).toBe(DESKTOP_BASE_ZOOM);
  });

  test('a zoom chosen against the CURRENT base survives a restart', async () => {
    const store = setStorage();
    await setDesktopZoom(1.2);
    expect(JSON.parse(store.get('kortix-desktop-zoom')!)).toEqual({
      scale: 1.2,
      base: DESKTOP_BASE_ZOOM,
    });
    expect(getDesktopZoom()).toBe(1.2);
  });

  // THE REGRESSION: 0.826 (two Cmd+- presses against an older default) kept
  // winning, so changing the constant changed nothing on screen.
  test('a zoom chosen against an OLDER base is stale, and the new default wins', () => {
    setStorage({
      'kortix-desktop-zoom': JSON.stringify({ scale: 0.8264462809917354, base: 0.9 }),
    });
    expect(getDesktopZoom()).toBe(DESKTOP_BASE_ZOOM);
  });

  // Values written before the stamp existed were bare numbers.
  test('an unstamped legacy value is treated as stale', () => {
    setStorage({ 'kortix-desktop-zoom': '0.8264462809917354' });
    expect(getDesktopZoom()).toBe(DESKTOP_BASE_ZOOM);
  });

  test('a corrupt value never throws, it falls back', () => {
    setStorage({ 'kortix-desktop-zoom': '{not json' });
    expect(getDesktopZoom()).toBe(DESKTOP_BASE_ZOOM);
  });

  test('reset returns to the shell scale, not the browser 100%', async () => {
    setStorage();
    await zoomReset();
    expect(getDesktopZoom()).toBe(DESKTOP_BASE_ZOOM);
    expect(DESKTOP_BASE_ZOOM).not.toBe(1);
  });
});

/* ── Per-channel deep-link scheme ─────────────────────────────────────────
   Prod, staging and dev desktop builds install side by side, so the OAuth
   bounce must name the scheme of the build that started the sign-in. The shell
   advertises it in its user-agent; authRedirectUrl carries it to the callback
   URL, because the page that renders the deep link runs in the user's SYSTEM
   browser and knows nothing about the app. */

describe('desktopUrlScheme', () => {
  test('reads the scheme the shell advertises', () => {
    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0 KortixScheme/kortix-dev', 'MacIntel');
    expect(desktopUrlScheme()).toBe('kortix-dev');

    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0 KortixScheme/kortix-staging', 'MacIntel');
    expect(desktopUrlScheme()).toBe('kortix-staging');
  });

  // Every build shipped before per-channel schemes existed sends no token and
  // answers only kortix://.
  test('falls back to kortix for a shell that advertises nothing', () => {
    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0', 'MacIntel');
    expect(desktopUrlScheme()).toBe('kortix');
  });

  test('falls back to kortix in a plain browser', () => {
    setNavigator('Mozilla/5.0 (Macintosh) Chrome/120', 'MacIntel');
    expect(desktopUrlScheme()).toBe('kortix');
  });

  // The UA is not a trust boundary, but it still must not smuggle a protocol.
  test('rejects a scheme that is not one of ours', () => {
    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0 KortixScheme/javascript', 'MacIntel');
    expect(desktopUrlScheme()).toBe('kortix');
  });
});

describe('authRedirectUrl carries the channel', () => {
  function setWindow(origin: string) {
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin } },
      configurable: true,
      writable: true,
    });
  }

  test('a dev build asks for its own scheme back', () => {
    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0 KortixScheme/kortix-dev', 'MacIntel');
    setWindow('https://dev.kortix.com');
    const url = new URL(authRedirectUrl('/auth/callback'));
    expect(url.origin).toBe('https://dev.kortix.com');
    expect(url.searchParams.get('desktop')).toBe('true');
    expect(url.searchParams.get('desktop_scheme')).toBe('kortix-dev');
  });

  test('an existing query string is preserved', () => {
    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0 KortixScheme/kortix-staging', 'MacIntel');
    setWindow('https://staging.kortix.com');
    const url = new URL(authRedirectUrl('/auth/callback?returnUrl=%2Fprojects'));
    expect(url.searchParams.get('returnUrl')).toBe('/projects');
    expect(url.searchParams.get('desktop_scheme')).toBe('kortix-staging');
  });

  test('a browser gets no desktop markers at all', () => {
    setNavigator('Mozilla/5.0 (Macintosh) Chrome/120', 'MacIntel');
    setWindow('https://kortix.com');
    expect(authRedirectUrl('/auth/callback')).toBe('https://kortix.com/auth/callback');
  });
});

// The whole point of the chain: a dev build's sign-in ends up back in the dev
// build, not in whichever Kortix app the OS registered last.
describe('end to end: shell UA → callback URL → deep link', () => {
  test('a dev build round-trips to kortix-dev://', () => {
    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0 KortixScheme/kortix-dev', 'MacIntel');
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://dev.kortix.com' } },
      configurable: true,
      writable: true,
    });

    // 1. The app builds the OAuth redirect target.
    const callbackUrl = new URL(authRedirectUrl('/auth/callback'));
    // 2. Supabase 302s the SYSTEM browser there, plus the auth code.
    callbackUrl.searchParams.set('code', 'abc123');
    // 3. The route hands the code back to the app that started the sign-in.
    expect(buildDesktopDeepLink(callbackUrl.searchParams)).toBe(
      'kortix-dev://auth/callback?code=abc123',
    );
  });

  test('a legacy build with no scheme token still round-trips to kortix://', () => {
    setNavigator('Mozilla/5.0 KortixDesktop/0.1.0', 'MacIntel');
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://kortix.com' } },
      configurable: true,
      writable: true,
    });
    const callbackUrl = new URL(authRedirectUrl('/auth/callback'));
    callbackUrl.searchParams.set('code', 'abc123');
    expect(buildDesktopDeepLink(callbackUrl.searchParams)).toBe(
      'kortix://auth/callback?code=abc123',
    );
  });
});

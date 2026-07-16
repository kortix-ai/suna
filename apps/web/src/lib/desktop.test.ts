import { afterEach, describe, expect, test } from 'bun:test';

import { desktopPlatform, desktopShellPlatform, isDesktop, openExternalRoute } from '@/lib/desktop';

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

    expect(openExternalRoute('/legal?tab=terms')).toBe(true);
    expect(openExternalRoute('/legal?tab=privacy')).toBe(true);
    expect(clicks).toEqual([
      { href: 'https://kortix.com/legal?tab=terms', target: undefined, rel: undefined },
      { href: 'https://kortix.com/legal?tab=privacy', target: undefined, rel: undefined },
    ]);
  });

  test('leaves legal navigation to Next.js in a regular browser', () => {
    setNavigator('Mozilla/5.0 Safari/605.1.15', 'MacIntel');
    expect(openExternalRoute('/legal?tab=terms')).toBe(false);
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

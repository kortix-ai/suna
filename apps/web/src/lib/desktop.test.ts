import { afterEach, describe, expect, test } from 'bun:test';

import { desktopPlatform, desktopShellPlatform, isDesktop } from '@/lib/desktop';

const originalNavigator = globalThis.navigator;

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

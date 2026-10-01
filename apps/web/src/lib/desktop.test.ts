import { afterEach, describe, expect, test } from 'bun:test';

import {
  DESKTOP_BASE_ZOOM,
  desktopComputerAccessGet,
  desktopComputerAccessSet,
  desktopComputerConnect,
  desktopComputerDisconnect,
  desktopCaptureStatus,
  desktopCapturePause,
  desktopCaptureResume,
  desktopCaptureRequestPermission,
  desktopComputerOpenLogs,
  desktopComputerPause,
  desktopComputerStatus,
  desktopPlatform,
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

describe('desktop computer commands', () => {
  test('return null in a browser, where there is no native bridge', async () => {
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
    expect(await desktopComputerStatus()).toBeNull();
    expect(
      await desktopComputerConnect({ projectId: 'p' }),
    ).toBeNull();
  });

  test('invoke the shell command with its arguments', async () => {
    const calls: Array<[string, unknown]> = [];
    Object.defineProperty(globalThis, 'window', {
      value: {
        __TAURI__: {
          core: {
            invoke: async (cmd: string, args?: unknown) => {
              calls.push([cmd, args]);
              if (cmd === 'computer_connect') return { ok: true, tunnelId: 't-1' };
              if (cmd === 'computer_pause') {
                return { ok: true, status: { available: true, paired: true, paused: true } };
              }
              return { available: true, paired: false };
            },
          },
        },
      },
      configurable: true,
      writable: true,
    });
    const input = { projectId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607' };
    expect(await desktopComputerConnect(input)).toEqual({ ok: true, tunnelId: 't-1' });
    expect(await desktopComputerStatus()).toMatchObject({ paired: false });
    expect(await desktopComputerPause()).toMatchObject({ paused: true });
    await desktopComputerOpenLogs();
    expect(calls.map(([cmd]) => cmd)).toEqual([
      'computer_connect',
      'computer_status',
      'computer_pause',
      'computer_open_logs',
    ]);
    expect(calls[0]![1]).toEqual(input);
  });

  test('capture commands pass their arguments and return null in a browser', async () => {
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
    expect(await desktopCaptureStatus()).toBeNull();
    const calls: Array<[string, unknown]> = [];
    Object.defineProperty(globalThis, 'window', {
      value: {
        __TAURI__: {
          core: {
            invoke: async (cmd: string, args?: unknown) => {
              calls.push([cmd, args]);
              return cmd === 'capture_request_permission' ? { ok: true, opened: true } : { state: 'paused', label: 'Capture: Paused' };
            },
          },
        },
      },
      configurable: true,
      writable: true,
    });
    expect(await desktopCaptureStatus()).toMatchObject({ state: 'paused' });
    await desktopCapturePause({ minutes: 30 });
    await desktopCaptureResume();
    expect(await desktopCaptureRequestPermission()).toEqual({ ok: true, opened: true });
    expect(calls).toEqual([
      ['capture_status', undefined],
      ['capture_pause', { minutes: 30 }],
      ['capture_resume', undefined],
      ['capture_request_permission', undefined],
    ]);
  });

  test('pause and resume reject with the reason when the desktop app reports a failure (X5)', async () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        __TAURI__: {
          core: {
            invoke: async (cmd: string) =>
              cmd === 'computer_pause'
                ? { ok: false, error: 'launchctl: Operation not permitted', status: { available: true } }
                : { available: true, paired: true, serviceActive: true },
          },
        },
      },
      configurable: true,
      writable: true,
    });
    await expect(desktopComputerPause()).rejects.toThrow('launchctl: Operation not permitted');
  });

  test('access get/set and disconnect pass through the desktop answers (X4, X5)', async () => {
    const calls: Array<[string, unknown]> = [];
    const access = {
      mode: 'ask',
      grantedUntil: null,
      deniedUntil: null,
      keepAwake: false,
      keepAwakeSupported: true,
      pendingRequest: null,
    };
    Object.defineProperty(globalThis, 'window', {
      value: {
        __TAURI__: {
          core: {
            invoke: async (cmd: string, args?: unknown) => {
              calls.push([cmd, args]);
              if (cmd === 'computer_access_set') {
                if ((args as { mode?: string }).mode === 'sometimes') throw new Error("Error invoking remote method 'kortix:invoke': Error: mode must be one of ask, always, off");
                return { ...access, ...(args as object) };
              }
              if (cmd === 'computer_disconnect') {
                return { ok: true, serverUnpaired: false, status: { available: true, paired: false } };
              }
              return access;
            },
          },
        },
      },
      configurable: true,
      writable: true,
    });
    expect(await desktopComputerAccessGet()).toEqual(access);
    expect(await desktopComputerAccessSet({ mode: 'always', keepAwake: true })).toMatchObject({ mode: 'always', keepAwake: true });
    await expect(desktopComputerAccessSet({ mode: 'sometimes' as 'ask' })).rejects.toThrow(
      'mode must be one of ask, always, off',
    );
    expect(await desktopComputerDisconnect()).toMatchObject({ ok: true, serverUnpaired: false });
    expect(calls.map(([cmd]) => cmd)).toEqual([
      'computer_access_get',
      'computer_access_set',
      'computer_access_set',
      'computer_disconnect',
    ]);
  });

  test('return null when an older shell rejects the command', async () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        __TAURI__: {
          core: {
            invoke: async () => {
              throw new Error('Unknown command: computer_status');
            },
          },
        },
      },
      configurable: true,
      writable: true,
    });
    expect(await desktopComputerStatus()).toBeNull();
  });
});

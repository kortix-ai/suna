import { describe, expect, test } from 'bun:test';

import { assertOpenableUrl, openCommand, openUrl } from './open-url.ts';

describe('openCommand', () => {
  test('macOS uses open', () => {
    expect(openCommand('https://a.kortix.app/', 'darwin')).toEqual([
      'open',
      'https://a.kortix.app/',
    ]);
  });

  test('Linux uses xdg-open', () => {
    expect(openCommand('https://a.kortix.app/', 'linux')).toEqual([
      'xdg-open',
      'https://a.kortix.app/',
    ]);
  });

  test('Windows uses cmd /c start with an empty title argument', () => {
    // The empty string is load-bearing: `start` reads its first quoted
    // argument as the window title, so without it a quoted URL is swallowed.
    expect(openCommand('https://a.kortix.app/', 'win32')).toEqual([
      'cmd',
      '/c',
      'start',
      '',
      'https://a.kortix.app/',
    ]);
  });

  test('an unknown platform falls back to xdg-open', () => {
    expect(openCommand('https://a.kortix.app/', 'freebsd')[0]).toBe('xdg-open');
  });
});

describe('assertOpenableUrl', () => {
  test('accepts http and https', () => {
    expect(assertOpenableUrl('https://a.kortix.app/x').protocol).toBe('https:');
    expect(assertOpenableUrl('http://localhost:3000').protocol).toBe('http:');
  });

  test('rejects a non-http scheme by name', () => {
    expect(() => assertOpenableUrl('file:///etc/passwd')).toThrow('Refusing to open a file: URL.');
    expect(() => assertOpenableUrl('javascript:alert(1)')).toThrow(
      'Refusing to open a javascript: URL.',
    );
  });

  test('rejects an empty row and a flag-shaped string', () => {
    expect(() => assertOpenableUrl('   ')).toThrow('No URL on this row.');
    expect(() => assertOpenableUrl('--version')).toThrow('reads as a flag');
  });

  test('rejects text that is not a URL', () => {
    expect(() => assertOpenableUrl('not a url')).toThrow('Not a URL: not a url');
  });
});

describe('openUrl', () => {
  test('spawns the platform opener with the URL and returns the argv', async () => {
    const calls: string[][] = [];
    const argv = await openUrl('https://acme.kortix.app/', {
      platform: 'darwin',
      spawn: (command) => {
        calls.push(command);
      },
    });
    expect(calls).toEqual([['open', 'https://acme.kortix.app/']]);
    expect(argv).toEqual(['open', 'https://acme.kortix.app/']);
  });

  test('never spawns anything for a rejected scheme', async () => {
    const calls: string[][] = [];
    await expect(
      openUrl('file:///etc/passwd', { platform: 'darwin', spawn: (c) => void calls.push(c) }),
    ).rejects.toThrow('Refusing to open a file: URL.');
    expect(calls).toEqual([]);
  });

  test('a missing opener binary surfaces as one line naming the command', async () => {
    await expect(
      openUrl('https://acme.kortix.app/', {
        platform: 'linux',
        spawn: () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toThrow('xdg-open failed: ENOENT');
  });

  test('awaits an async spawner before resolving', async () => {
    let launched = false;
    await openUrl('https://acme.kortix.app/', {
      platform: 'linux',
      spawn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        launched = true;
      },
    });
    expect(launched).toBe(true);
  });
});

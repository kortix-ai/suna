import { describe, expect, test } from 'bun:test';

import { openInBrowser } from '../browser.ts';

describe('openInBrowser', () => {
  test('does not spawn a browser in CI', () => {
    let spawned = false;

    const opened = openInBrowser('https://dev.kortix.com/cli/authorize', {
      env: { CI: '1' },
      platform: 'darwin',
      spawn() {
        spawned = true;
        throw new Error('must not run');
      },
    });

    expect(opened).toBe(false);
    expect(spawned).toBe(false);
  });

  test('swallows the asynchronous error emitted when a headless worker lacks xdg-open', () => {
    let errorListener: ((error: Error) => void) | undefined;
    let unrefCalled = false;

    const opened = openInBrowser('https://dev.kortix.com/cli/authorize', {
      env: {},
      platform: 'linux',
      spawn(command, args) {
        expect(command).toBe('xdg-open');
        expect(args).toEqual(['https://dev.kortix.com/cli/authorize']);
        return {
          once(event, listener) {
            expect(event).toBe('error');
            errorListener = listener;
            return this;
          },
          unref() {
            unrefCalled = true;
          },
        };
      },
    });

    expect(opened).toBe(true);
    expect(unrefCalled).toBe(true);
    expect(errorListener).toBeDefined();
    expect(() => errorListener?.(new Error('spawn xdg-open ENOENT'))).not.toThrow();
  });

  test('rejects non-HTTP URLs without spawning a process', () => {
    let spawned = false;
    const opened = openInBrowser('-malicious', {
      platform: 'linux',
      spawn() {
        spawned = true;
        throw new Error('must not run');
      },
    });

    expect(opened).toBe(false);
    expect(spawned).toBe(false);
  });
});

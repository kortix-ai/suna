import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from 'bun:test';

import { isChunkLoadError, reloadForStaleChunk, withStaleChunkRecovery } from './chunk-reload';

/**
 * The fake window is what the module needs and nothing more: a sessionStorage
 * Map and a reload counter. bun tests have no DOM, so `typeof window` is
 * 'undefined' until one is installed — that state is itself the SSR case.
 */
interface FakeWindow {
  sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  location: { reload(): void };
}

function installFakeWindow(): { reloads: () => number; store: Map<string, string> } {
  const store = new Map<string, string>();
  let reloads = 0;
  const fake: FakeWindow = {
    sessionStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
    location: { reload: () => void reloads++ },
  };
  Reflect.set(globalThis, 'window', fake);
  return { reloads: () => reloads, store };
}

function installThrowingStorage(): { reloads: () => number } {
  let reloads = 0;
  const fake: FakeWindow = {
    sessionStorage: {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
    },
    location: { reload: () => void reloads++ },
  };
  Reflect.set(globalThis, 'window', fake);
  return { reloads: () => reloads };
}

const chunkFetchError = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost:3000/_next/static/chunks/panel.js',
);

/** Drain the microtasks the recovery chain runs in after a rejection. */
async function flushRecovery(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('isChunkLoadError', () => {
  test('matches the ChunkLoadError name', () => {
    const error = new Error('Loading chunk 14 failed.');
    error.name = 'ChunkLoadError';
    expect(isChunkLoadError(error)).toBe(true);
  });

  test('matches the failed-to-fetch dynamic import message (Chrome)', () => {
    expect(isChunkLoadError(chunkFetchError)).toBe(true);
  });

  test('matches the Firefox native import error message', () => {
    expect(
      isChunkLoadError(new TypeError('error loading dynamically imported module /_next/x.js')),
    ).toBe(true);
  });

  test('matches the Safari native import error message', () => {
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
  });

  test('rejects an ordinary module error', () => {
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });

  test('rejects a non-error rejection', () => {
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({ name: 'ChunkLoadError' })).toBe(false);
  });
});

describe('reloadForStaleChunk', () => {
  beforeEach(() => setSystemTime(1_000_000));

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    setSystemTime();
  });

  test('refuses without a window (SSR)', () => {
    expect(reloadForStaleChunk()).toBe(false);
  });

  test('reloads once and records the guard', () => {
    const fake = installFakeWindow();
    expect(reloadForStaleChunk()).toBe(true);
    expect(fake.reloads()).toBe(1);
    expect(fake.store.get('kortix.staleChunkReloadAt')).toBe(String(1_000_000));
  });

  test('refuses a second reload within 45 s', () => {
    const fake = installFakeWindow();
    expect(reloadForStaleChunk()).toBe(true);
    setSystemTime(1_000_000 + 44_999);
    expect(reloadForStaleChunk()).toBe(false);
    expect(fake.reloads()).toBe(1);
  });

  test('reloads again after the cooldown', () => {
    const fake = installFakeWindow();
    expect(reloadForStaleChunk()).toBe(true);
    setSystemTime(1_000_000 + 45_000);
    expect(reloadForStaleChunk()).toBe(true);
    expect(fake.reloads()).toBe(2);
  });

  test('refuses when storage is unavailable — no brake, no reload', () => {
    const fake = installThrowingStorage();
    expect(reloadForStaleChunk()).toBe(false);
    expect(fake.reloads()).toBe(0);
  });
});

describe('withStaleChunkRecovery', () => {
  beforeEach(() => setSystemTime(1_000_000));

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    // Fake timers are process-wide in bun. Left on, they hang the next test
    // file in this worker that waits on a real timer (the whole apps/web run
    // stalled at 0% CPU behind sign-out-sequence.test.ts).
    jest.useRealTimers();
    setSystemTime();
  });

  test('passes a healthy module through untouched', async () => {
    const fake = installFakeWindow();
    const body = { default: () => null };
    const wrapped = withStaleChunkRecovery(async () => body);
    expect(await wrapped()).toBe(body);
    expect(fake.reloads()).toBe(0);
  });

  test('recovers a rejected chunk import: one reload, boundary held', async () => {
    const fake = installFakeWindow();
    const wrapped = withStaleChunkRecovery(() => Promise.reject(chunkFetchError));
    const held = wrapped();
    await flushRecovery();
    expect(fake.reloads()).toBe(1);
    expect(fake.store.has('kortix.staleChunkReloadAt')).toBe(true);
    // The promise next/dynamic waits on never settles while the page reloads.
    expect(await Promise.race([held.then(() => 'settled'), flushRecovery().then(() => 'held')])).toBe(
      'held',
    );
  });

  test('rethrows a non-chunk rejection without reloading', async () => {
    const fake = installFakeWindow();
    const wrapped = withStaleChunkRecovery<never>(() => Promise.reject(new Error('boom')));
    await expect(wrapped()).rejects.toThrow('boom');
    expect(fake.reloads()).toBe(0);
  });

  test('rethrows when the guard refuses the second failure inside the cooldown', async () => {
    const fake = installFakeWindow();
    const wrapped = withStaleChunkRecovery<never>(() => Promise.reject(chunkFetchError));
    wrapped();
    await flushRecovery();
    await expect(wrapped()).rejects.toThrow('Failed to fetch dynamically imported module');
    expect(fake.reloads()).toBe(1);
  });

  test('recovers a hung import once the timeout fires', async () => {
    jest.useFakeTimers();
    const fake = installFakeWindow();
    const wrapped = withStaleChunkRecovery<never>(() => new Promise(() => {}));
    const held = wrapped();
    jest.advanceTimersByTime(15_000);
    await flushRecovery();
    expect(fake.reloads()).toBe(1);
    expect(await Promise.race([held.then(() => 'settled'), flushRecovery().then(() => 'held')])).toBe(
      'held',
    );
  });

  test('does not reload when a hung import settles before the timeout', async () => {
    jest.useFakeTimers();
    const fake = installFakeWindow();
    const body = { default: () => null };
    let resolveLoader: (value: typeof body) => void = () => {};
    const wrapped = withStaleChunkRecovery(
      () => new Promise<typeof body>((resolve) => void (resolveLoader = resolve)),
    );
    const pending = wrapped();
    jest.advanceTimersByTime(14_999);
    resolveLoader(body);
    expect(await pending).toBe(body);
    jest.advanceTimersByTime(1_000);
    await flushRecovery();
    expect(fake.reloads()).toBe(0);
  });
});

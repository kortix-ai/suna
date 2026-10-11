import { expect, test } from 'bun:test';

import {
  CHUNK_RELOAD_WINDOW_MS,
  isChunkLoadError,
  reloadForChunkLoadError,
} from './chunk-load-recovery';

const webpackChunkError = (message: string, stack?: string) => {
  const err = new Error(message);
  if (stack !== undefined) err.stack = stack;
  return err;
};

function fakeStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

test('classifies the webpack ChunkLoadError spellings', () => {
  const named = webpackChunkError('Loading chunk 42 failed.');
  named.name = 'ChunkLoadError';
  expect(isChunkLoadError(named)).toBe(true);
  // webpack appends the failing URL on the next line.
  expect(
    isChunkLoadError(
      webpackChunkError('Loading chunk 42 failed.\n(error: https://app.example/_next/static/chunks/42.abc.js)'),
    ),
  ).toBe(true);
});

test('classifies the native dynamic-import failure spellings', () => {
  expect(
    isChunkLoadError(
      webpackChunkError('TypeError: Failed to fetch dynamically imported module: https://app.example/_next/static/chunks/a.js'),
    ),
  ).toBe(true);
  expect(isChunkLoadError(webpackChunkError('Importing a module script failed.'))).toBe(true);
  expect(isChunkLoadError(webpackChunkError('error loading dynamically imported module https://app.example/_next/static/chunks/a.js'))).toBe(true);
});

test('classifies the stale webpack runtime TypeError only with a runtime chunk stack', () => {
  expect(
    isChunkLoadError(
      webpackChunkError("Cannot read properties of undefined (reading 'call')", 'TypeError: Cannot read properties of undefined (reading \'call\')\n    at c (https://app.example/_next/static/chunks/webpack-9f3a.js:1:22)'),
    ),
  ).toBe(true);
  // The same message inside app code is a real bug, not a chunk-load failure.
  expect(
    isChunkLoadError(
      webpackChunkError("Cannot read properties of undefined (reading 'call')", 'TypeError: Cannot read properties of undefined (reading \'call\')\n    at settings-panel (https://app.example/_next/static/chunks/21544-abc.js:9:100)'),
    ),
  ).toBe(false);
});

test('rejects errors that are not chunk-load failures', () => {
  expect(isChunkLoadError(webpackChunkError('Cannot read properties of undefined (reading \'map\')'))).toBe(false);
  expect(isChunkLoadError(webpackChunkError('Failed to fetch'))).toBe(false);
  expect(isChunkLoadError(webpackChunkError('NetworkError when attempting to fetch resource.'))).toBe(false);
  expect(isChunkLoadError(webpackChunkError('Request exceeded the 25s server processing deadline'))).toBe(false);
  expect(isChunkLoadError(null)).toBe(false);
  expect(isChunkLoadError('ChunkLoadError: Loading chunk 42 failed.')).toBe(false);
  expect(isChunkLoadError(undefined)).toBe(false);
});

test('the first chunk-load failure reloads once and records the mark', () => {
  const storage = fakeStorage();
  let reloads = 0;
  const now = 1_000_000;
  const fired = reloadForChunkLoadError(webpackChunkError('Importing a module script failed.'), {
    now: () => now,
    storage,
    reload: () => {
      reloads += 1;
    },
  });
  expect(fired).toBe(true);
  expect(reloads).toBe(1);
  expect(Number(storage.map.get('kortix:chunk-reload-at'))).toBe(1_000_000);
});

test('a second sighting inside the window does not reload again', () => {
  const storage = fakeStorage({ 'kortix:chunk-reload-at': String(1_000_000) });
  let reloads = 0;
  const fired = reloadForChunkLoadError(webpackChunkError('Loading chunk 42 failed.'), {
    now: () => 1_000_000 + CHUNK_RELOAD_WINDOW_MS - 1,
    storage,
    reload: () => {
      reloads += 1;
    },
  });
  expect(fired).toBe(false);
  expect(reloads).toBe(0);
});

test('a sighting after the window may reload once more', () => {
  const storage = fakeStorage({ 'kortix:chunk-reload-at': String(1_000_000) });
  let reloads = 0;
  const fired = reloadForChunkLoadError(webpackChunkError('Loading chunk 42 failed.'), {
    now: () => 1_000_000 + CHUNK_RELOAD_WINDOW_MS,
    storage,
    reload: () => {
      reloads += 1;
    },
  });
  expect(fired).toBe(true);
  expect(reloads).toBe(1);
  expect(storage.map.get('kortix:chunk-reload-at')).toBe(String(1_000_000 + CHUNK_RELOAD_WINDOW_MS));
});

test('a non-chunk error never reloads and never writes the mark', () => {
  const storage = fakeStorage();
  let reloads = 0;
  const fired = reloadForChunkLoadError(webpackChunkError('Cannot read properties of undefined (reading \'map\')'), {
    now: () => 1_000_000,
    storage,
    reload: () => {
      reloads += 1;
    },
  });
  expect(fired).toBe(false);
  expect(reloads).toBe(0);
  expect(storage.map.size).toBe(0);
});

test('without storage there is no unguarded reload', () => {
  let reloads = 0;
  const fired = reloadForChunkLoadError(webpackChunkError('Loading chunk 42 failed.'), {
    now: () => 1_000_000,
    storage: null,
    reload: () => {
      reloads += 1;
    },
  });
  expect(fired).toBe(false);
  expect(reloads).toBe(0);
});

test('a throwing storage read or write suppresses the reload', () => {
  let reloads = 0;
  const boom = () => {
    throw new Error('quota');
  };
  expect(
    reloadForChunkLoadError(webpackChunkError('Loading chunk 42 failed.'), {
      now: () => 1_000_000,
      storage: { getItem: boom, setItem: boom },
      reload: () => {
        reloads += 1;
      },
    }),
  ).toBe(false);
  // A read that works but a write that throws must not reload unguarded either.
  expect(
    reloadForChunkLoadError(webpackChunkError('Loading chunk 42 failed.'), {
      now: () => 1_000_000,
      storage: { getItem: () => null, setItem: boom },
      reload: () => {
        reloads += 1;
      },
    }),
  ).toBe(false);
  expect(reloads).toBe(0);
});

test('a corrupt mark is treated as absent and reloads once', () => {
  const storage = fakeStorage({ 'kortix:chunk-reload-at': 'not-a-number' });
  let reloads = 0;
  const fired = reloadForChunkLoadError(webpackChunkError('Loading chunk 42 failed.'), {
    now: () => 1_000_000,
    storage,
    reload: () => {
      reloads += 1;
    },
  });
  expect(fired).toBe(true);
  expect(reloads).toBe(1);
});

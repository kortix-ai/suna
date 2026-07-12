import { test, expect, afterEach } from 'bun:test';
import {
  clearSessionRuntime,
  getSessionRuntime,
  setSessionRuntime,
} from './session-runtime-registry';

const PROJECT = 'proj-registry-test';
const SESSION = 'sess-registry-test';

afterEach(() => {
  clearSessionRuntime(PROJECT, SESSION);
});

test('getSessionRuntime returns undefined for a session no handle has resolved yet', () => {
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test('setSessionRuntime records an entry retrievable by the same (projectId, sessionId)', () => {
  setSessionRuntime(PROJECT, SESSION, {
    opencodeSessionId: 'ocs-1',
    runtimeUrl: 'http://backend.test/p/sb-1/8000',
    sandboxId: 'sb-1',
  });

  expect(getSessionRuntime(PROJECT, SESSION)).toEqual({
    opencodeSessionId: 'ocs-1',
    runtimeUrl: 'http://backend.test/p/sb-1/8000',
    sandboxId: 'sb-1',
  });
});

test('entries for different session ids never collide', () => {
  setSessionRuntime(PROJECT, SESSION, {
    opencodeSessionId: 'ocs-1',
    runtimeUrl: 'http://backend.test/p/sb-1/8000',
    sandboxId: 'sb-1',
  });
  setSessionRuntime(PROJECT, 'sess-other', {
    opencodeSessionId: 'ocs-2',
    runtimeUrl: 'http://backend.test/p/sb-2/8000',
    sandboxId: 'sb-2',
  });

  expect(getSessionRuntime(PROJECT, SESSION)?.sandboxId).toBe('sb-1');
  expect(getSessionRuntime(PROJECT, 'sess-other')?.sandboxId).toBe('sb-2');

  clearSessionRuntime(PROJECT, 'sess-other');
});

test('entries for the same session id under different projects never collide', () => {
  setSessionRuntime('proj-a', SESSION, {
    opencodeSessionId: 'ocs-a',
    runtimeUrl: 'http://backend.test/p/sb-a/8000',
    sandboxId: 'sb-a',
  });
  setSessionRuntime('proj-b', SESSION, {
    opencodeSessionId: 'ocs-b',
    runtimeUrl: 'http://backend.test/p/sb-b/8000',
    sandboxId: 'sb-b',
  });

  expect(getSessionRuntime('proj-a', SESSION)?.sandboxId).toBe('sb-a');
  expect(getSessionRuntime('proj-b', SESSION)?.sandboxId).toBe('sb-b');

  clearSessionRuntime('proj-a', SESSION);
  clearSessionRuntime('proj-b', SESSION);
});

test('clearSessionRuntime removes the entry (restart/delete invalidation)', () => {
  setSessionRuntime(PROJECT, SESSION, {
    opencodeSessionId: 'ocs-1',
    runtimeUrl: 'http://backend.test/p/sb-1/8000',
    sandboxId: 'sb-1',
  });
  clearSessionRuntime(PROJECT, SESSION);

  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test('clearSessionRuntime on an unregistered session is a no-op (never throws)', () => {
  expect(() => clearSessionRuntime('proj-never', 'sess-never')).not.toThrow();
});

// ─────────────────────────────────────────────────────────────────────────
// Bounded LRU (max 512 entries)
// ─────────────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 512;

function fillEntry(i: number) {
  return {
    opencodeSessionId: `ocs-${i}`,
    runtimeUrl: `http://backend.test/p/sb-${i}/8000`,
    sandboxId: `sb-${i}`,
  };
}

function fillRegistry(projectId: string, count: number, offset = 0) {
  for (let i = offset; i < offset + count; i++) {
    setSessionRuntime(projectId, `sess-lru-${i}`, fillEntry(i));
  }
}

function clearRegistry(projectId: string, count: number, offset = 0) {
  for (let i = offset; i < offset + count; i++) {
    clearSessionRuntime(projectId, `sess-lru-${i}`);
  }
}

test('inserting beyond the cap evicts the oldest (least-recently-touched) entry first', () => {
  const PROJ = 'proj-lru-evict';
  try {
    fillRegistry(PROJ, MAX_ENTRIES);
    // Registry is now exactly at the cap; every entry present.
    expect(getSessionRuntime(PROJ, 'sess-lru-0')).toBeDefined();

    // One more insert must evict the oldest untouched entry (index 0), since
    // reading it above via getSessionRuntime touched it... so instead verify
    // with a fresh untouched oldest entry: index 1 was never read, so it's
    // now the least-recently-used and should be evicted next.
    setSessionRuntime(PROJ, 'sess-lru-overflow', fillEntry(999_001));

    // index 0 was touched by the read above, so it survives.
    expect(getSessionRuntime(PROJ, 'sess-lru-0')).toBeDefined();
    // index 1 was never touched and was the oldest remaining — evicted.
    expect(getSessionRuntime(PROJ, 'sess-lru-1')).toBeUndefined();
    // the new entry is present.
    expect(getSessionRuntime(PROJ, 'sess-lru-overflow')).toBeDefined();
  } finally {
    clearRegistry(PROJ, MAX_ENTRIES);
    clearSessionRuntime(PROJ, 'sess-lru-overflow');
  }
});

test('getSessionRuntime (read) touches an entry, protecting it from being the next eviction', () => {
  const PROJ = 'proj-lru-touch';
  try {
    fillRegistry(PROJ, MAX_ENTRIES);

    // Touch the very oldest entry (index 0) via a read, promoting it to MRU.
    expect(getSessionRuntime(PROJ, 'sess-lru-0')).toBeDefined();

    // Next insert should now evict index 1 (the new oldest), not index 0.
    setSessionRuntime(PROJ, 'sess-lru-touch-overflow', fillEntry(999_002));

    expect(getSessionRuntime(PROJ, 'sess-lru-0')).toBeDefined();
    expect(getSessionRuntime(PROJ, 'sess-lru-1')).toBeUndefined();
  } finally {
    clearRegistry(PROJ, MAX_ENTRIES);
    clearSessionRuntime(PROJ, 'sess-lru-touch-overflow');
  }
});

test('re-setting an existing key updates it in place without evicting anything (cap not exceeded)', () => {
  const PROJ = 'proj-lru-reset';
  try {
    fillRegistry(PROJ, MAX_ENTRIES);

    // Overwrite an existing key — size stays at the cap, nothing should be evicted.
    setSessionRuntime(PROJ, 'sess-lru-5', fillEntry(999_003));
    expect(getSessionRuntime(PROJ, 'sess-lru-5')).toEqual(fillEntry(999_003));

    // Every other original entry (besides the one just touched via the
    // assertion above) should still be present — no eviction occurred.
    expect(getSessionRuntime(PROJ, 'sess-lru-0')).toBeDefined();
    expect(getSessionRuntime(PROJ, 'sess-lru-1')).toBeDefined();
    expect(getSessionRuntime(PROJ, `sess-lru-${MAX_ENTRIES - 1}`)).toBeDefined();
  } finally {
    clearRegistry(PROJ, MAX_ENTRIES);
  }
});

test('the cap is respected across many overflows — size never exceeds MAX_ENTRIES', () => {
  const PROJ = 'proj-lru-cap';
  try {
    // Insert 2x the cap; only the most recent MAX_ENTRIES should remain.
    fillRegistry(PROJ, MAX_ENTRIES * 2);

    let present = 0;
    for (let i = 0; i < MAX_ENTRIES * 2; i++) {
      if (getSessionRuntime(PROJ, `sess-lru-${i}`) !== undefined) present++;
    }
    expect(present).toBe(MAX_ENTRIES);

    // The first half (oldest) should all be gone; the second half (newest) all present.
    expect(getSessionRuntime(PROJ, 'sess-lru-0')).toBeUndefined();
    expect(getSessionRuntime(PROJ, `sess-lru-${MAX_ENTRIES * 2 - 1}`)).toBeDefined();
  } finally {
    clearRegistry(PROJ, MAX_ENTRIES * 2);
  }
});

test('explicit clearSessionRuntime still works once the registry is at/near capacity', () => {
  const PROJ = 'proj-lru-clear';
  try {
    fillRegistry(PROJ, MAX_ENTRIES);
    clearSessionRuntime(PROJ, 'sess-lru-10');
    expect(getSessionRuntime(PROJ, 'sess-lru-10')).toBeUndefined();

    // Clearing frees a slot — inserting one more should NOT evict anything else.
    setSessionRuntime(PROJ, 'sess-lru-after-clear', fillEntry(999_004));
    expect(getSessionRuntime(PROJ, 'sess-lru-after-clear')).toBeDefined();
    expect(getSessionRuntime(PROJ, 'sess-lru-0')).toBeDefined();
  } finally {
    clearRegistry(PROJ, MAX_ENTRIES);
    clearSessionRuntime(PROJ, 'sess-lru-after-clear');
  }
});

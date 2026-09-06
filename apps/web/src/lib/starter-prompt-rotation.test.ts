import { describe, expect, test } from 'bun:test';

import {
  RECENT_MEMORY,
  isRotationUsable,
  nextLocalMidnight,
  nextRecent,
  pickRotation,
} from './starter-prompt-rotation';

const POOL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const POOL_IDS = new Set(POOL);

/** A deterministic stand-in for `Math.random`, cycling the given values. */
function sequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('nextLocalMidnight', () => {
  test('is midnight tonight, in local time, not now', () => {
    const now = new Date(2026, 8, 1, 14, 37, 12, 500).getTime();
    const midnight = new Date(nextLocalMidnight(now));

    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(0);
    expect(midnight.getSeconds()).toBe(0);
    expect(midnight.getMilliseconds()).toBe(0);
    expect(midnight.getDate()).toBe(2);
    expect(midnight.getTime()).toBeGreaterThan(now);
  });

  // `setDate(getDate() + 1)` needs a branch for each of these; `setHours(24)`
  // does not, which is the whole reason it is written that way.
  test('crosses a month end', () => {
    const midnight = new Date(nextLocalMidnight(new Date(2026, 0, 31, 23, 59).getTime()));
    expect(midnight.getMonth()).toBe(1);
    expect(midnight.getDate()).toBe(1);
  });

  test('crosses a year end', () => {
    const midnight = new Date(nextLocalMidnight(new Date(2026, 11, 31, 23, 59).getTime()));
    expect(midnight.getFullYear()).toBe(2027);
    expect(midnight.getMonth()).toBe(0);
    expect(midnight.getDate()).toBe(1);
  });

  test('a minute before midnight still resolves forward, not to today', () => {
    const now = new Date(2026, 8, 1, 23, 59, 0).getTime();
    expect(nextLocalMidnight(now)).toBeGreaterThan(now);
  });
});

describe('pickRotation', () => {
  test('returns exactly `count` ids, all distinct, all from the pool', () => {
    const picked = pickRotation(POOL, 5, sequence([0.1, 0.9, 0.4, 0.7, 0.2]));

    expect(picked).toHaveLength(5);
    expect(new Set(picked).size).toBe(5);
    for (const id of picked) expect(POOL_IDS.has(id)).toBe(true);
  });

  test('does not mutate the pool it was handed', () => {
    const original = [...POOL];
    pickRotation(POOL, 5, sequence([0.5]));
    expect(POOL).toEqual(original);
  });

  test('is deterministic for a given random sequence', () => {
    const a = pickRotation(POOL, 5, sequence([0.1, 0.9, 0.4, 0.7, 0.2]));
    const b = pickRotation(POOL, 5, sequence([0.1, 0.9, 0.4, 0.7, 0.2]));
    expect(a).toEqual(b);
  });

  test('different randomness gives a different set — the point of the feature', () => {
    const a = pickRotation(POOL, 5, sequence([0, 0, 0, 0, 0]));
    const b = pickRotation(POOL, 5, sequence([0.99, 0.99, 0.99, 0.99, 0.99]));
    expect(a).not.toEqual(b);
  });

  // A pool smaller than the band shows what there is rather than throwing or
  // padding with duplicates.
  test('a short pool yields the whole pool, not a crash', () => {
    const picked = pickRotation(['x', 'y'], 5, sequence([0.5]));
    expect(picked).toHaveLength(2);
    expect(new Set(picked).size).toBe(2);
  });

  test('count 0 and an empty pool both yield nothing', () => {
    expect(pickRotation(POOL, 0, sequence([0.5]))).toEqual([]);
    expect(pickRotation([], 5, sequence([0.5]))).toEqual([]);
  });

  // `random()` returning exactly 1 would index one past the end. Guarding it
  // here rather than trusting every implementation to be half-open.
  test('a random() that returns 1 never indexes past the end', () => {
    const picked = pickRotation(POOL, 5, () => 0.999999999);
    expect(picked).toHaveLength(5);
    for (const id of picked) expect(POOL_IDS.has(id)).toBe(true);
  });
});

describe('pickRotation avoids what was shown recently', () => {
  test('never returns an id in `recent` while candidates remain', () => {
    const recent = ['a', 'b', 'c'];
    for (let i = 0; i < 200; i++) {
      const picked = pickRotation(POOL, 3, Math.random, recent);
      for (const id of picked) expect(recent).not.toContain(id);
    }
  });

  // Freshness is a preference; a full band is a requirement. An over-constrained
  // `recent` must not produce a short row list.
  test('falls back to the whole pool rather than returning a short band', () => {
    const picked = pickRotation(POOL, 5, Math.random, POOL);
    expect(picked).toHaveLength(5);
    expect(new Set(picked).size).toBe(5);
  });

  test('falls back the moment exclusion would leave fewer than `count`', () => {
    // Six in the pool, four excluded, five wanted — two candidates is not
    // enough, so the whole pool is back in play.
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'];
    const picked = pickRotation(pool, 5, Math.random, ['a', 'b', 'c', 'd']);
    expect(picked).toHaveLength(5);
  });

  test('exactly `count` candidates is enough — no needless fallback', () => {
    const picked = pickRotation(POOL, 3, Math.random, ['a', 'b', 'c', 'd', 'e']);
    expect(picked.sort()).toEqual(['f', 'g', 'h']);
  });

  // The regression this exists for. Measured before the memory existed: 22% of
  // days repeated at least one of yesterday's prompts, worst case 4 of 5.
  test('consecutive rolls never repeat, over a long run', () => {
    const pool = Array.from({ length: 106 }, (_, i) => `p${i}`);
    const ids = new Set(pool);
    let recent: string[] = [];
    let previous: string[] = [];

    for (let day = 0; day < 365; day++) {
      const picked = pickRotation(pool, 5, Math.random, recent);
      for (const id of picked) expect(previous).not.toContain(id);
      recent = nextRecent(picked, recent, ids);
      previous = picked;
    }
  });

  // ...but nothing is retired for good, which is the other half of the ask.
  test('the whole pool still comes around within a year', () => {
    const pool = Array.from({ length: 106 }, (_, i) => `p${i}`);
    const ids = new Set(pool);
    let recent: string[] = [];
    const seen = new Set<string>();

    for (let day = 0; day < 365; day++) {
      const picked = pickRotation(pool, 5, Math.random, recent);
      picked.forEach((id) => seen.add(id));
      recent = nextRecent(picked, recent, ids);
    }

    expect(seen.size).toBe(pool.length);
  });
});

describe('nextRecent keeps the window honest', () => {
  test('today lands in front of yesterday', () => {
    expect(nextRecent(['a', 'b'], ['c', 'd'], POOL_IDS)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('caps at RECENT_MEMORY, dropping the oldest', () => {
    const old = Array.from({ length: RECENT_MEMORY }, (_, i) => `old${i}`);
    const window = nextRecent(['a'], old, new Set([...old, 'a']));
    expect(window).toHaveLength(RECENT_MEMORY);
    expect(window[0]).toBe('a');
    expect(window).not.toContain(`old${RECENT_MEMORY - 1}`);
  });

  test('collapses duplicates rather than spending the window on them', () => {
    expect(nextRecent(['a'], ['a', 'b'], POOL_IDS)).toEqual(['a', 'b']);
  });

  // It has been through localStorage, so it can be anything.
  test('drops ids that are not strings or have left the pool', () => {
    const dirty = ['b', 'gone', 42, null, { id: 'c' }];
    expect(nextRecent(['a'], dirty, POOL_IDS)).toEqual(['a', 'b']);
  });

  test('a non-array previous window is treated as empty', () => {
    expect(nextRecent(['a'], 'not an array', POOL_IDS)).toEqual(['a']);
    expect(nextRecent(['a'], null, POOL_IDS)).toEqual(['a']);
    expect(nextRecent(['a'], undefined, POOL_IDS)).toEqual(['a']);
  });
});

describe('isRotationUsable says no, so the store re-picks', () => {
  const now = 1_000;
  const fresh = { ids: ['a', 'b', 'c'], expiresAt: now + 1 };

  test('accepts a well-formed, unexpired set', () => {
    expect(isRotationUsable(fresh, now, POOL_IDS, 3)).toBe(true);
  });

  test('nothing persisted yet — the store on its empty defaults', () => {
    expect(isRotationUsable({ ids: [], expiresAt: 0 }, now, POOL_IDS, 3)).toBe(false);
  });

  // `persist` hands back whatever JSON parsed, so these are all reachable.
  test('not an object', () => {
    expect(isRotationUsable(null, now, POOL_IDS, 3)).toBe(false);
    expect(isRotationUsable(undefined, now, POOL_IDS, 3)).toBe(false);
    expect(isRotationUsable('a string', now, POOL_IDS, 3)).toBe(false);
    expect(isRotationUsable(42, now, POOL_IDS, 3)).toBe(false);
  });

  test('expired — the ordinary daily case', () => {
    expect(isRotationUsable({ ids: ['a', 'b', 'c'], expiresAt: now }, now, POOL_IDS, 3)).toBe(
      false,
    );
    expect(isRotationUsable({ ids: ['a', 'b', 'c'], expiresAt: now - 1 }, now, POOL_IDS, 3)).toBe(
      false,
    );
  });

  test('a missing or non-numeric expiry', () => {
    expect(isRotationUsable({ ids: ['a', 'b', 'c'] }, now, POOL_IDS, 3)).toBe(false);
    expect(isRotationUsable({ ids: ['a'], expiresAt: 'later' }, now, POOL_IDS, 3)).toBe(false);
    expect(isRotationUsable({ ids: ['a'], expiresAt: NaN }, now, POOL_IDS, 3)).toBe(false);
  });

  test('the wrong number of ids, because the layout changed', () => {
    expect(isRotationUsable(fresh, now, POOL_IDS, 5)).toBe(false);
    expect(isRotationUsable(fresh, now, POOL_IDS, 2)).toBe(false);
  });

  // The case that bites after a deploy: a prompt was renamed or removed, and
  // the persisted id now points at nothing.
  test('an id that has left the pool', () => {
    expect(
      isRotationUsable({ ids: ['a', 'b', 'gone'], expiresAt: now + 1 }, now, POOL_IDS, 3),
    ).toBe(false);
  });

  test('a duplicate id, which would render the same row twice', () => {
    expect(isRotationUsable({ ids: ['a', 'a', 'b'], expiresAt: now + 1 }, now, POOL_IDS, 3)).toBe(
      false,
    );
  });

  test('ids that are not strings, or not an array', () => {
    expect(isRotationUsable({ ids: [1, 2, 3], expiresAt: now + 1 }, now, POOL_IDS, 3)).toBe(false);
    expect(isRotationUsable({ ids: 'abc', expiresAt: now + 1 }, now, POOL_IDS, 3)).toBe(false);
  });
});

describe('a fresh pick is usable by the same rules that judge a persisted one', () => {
  test('what pickRotation produces, isRotationUsable accepts', () => {
    const now = Date.parse('2026-09-01T14:00:00Z');
    const rotation = {
      ids: pickRotation(POOL, 5, sequence([0.3, 0.6, 0.1, 0.8, 0.5])),
      expiresAt: nextLocalMidnight(now),
    };

    expect(isRotationUsable(rotation, now, POOL_IDS, 5)).toBe(true);
    // ...and stops being usable the instant its own expiry passes.
    expect(isRotationUsable(rotation, rotation.expiresAt, POOL_IDS, 5)).toBe(false);
  });
});

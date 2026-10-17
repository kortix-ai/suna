import { describe, expect, test } from 'bun:test';

import {
  bulkTargets,
  runSequentially,
  selectAllShown,
  selectRange,
  toggleSlug,
  visibleSelection,
} from './trigger-selection';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('selection', () => {
  test('toggle adds and removes one slug', () => {
    expect([...toggleSlug(new Set(), 'a')]).toEqual(['a']);
    expect([...toggleSlug(new Set(['a']), 'a')]).toEqual([]);
  });
  test('shift-click adds the range between anchor and target, either direction', () => {
    expect([...selectRange(new Set(['a']), order, 'b', 'd')].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...selectRange(new Set(), order, 'd', 'b')].sort()).toEqual(['b', 'c', 'd']);
  });
  test('shift-click without an anchor toggles the target', () => {
    expect([...selectRange(new Set(), order, null, 'c')]).toEqual(['c']);
    expect([...selectRange(new Set(), order, 'gone', 'c')]).toEqual(['c']);
  });
  test('select all takes every shown trigger only', () => {
    expect([...selectAllShown([{ slug: 'b' }, { slug: 'd' }])]).toEqual(['b', 'd']);
  });
  test('bulk targets skip triggers already in the wanted state', () => {
    const triggers = [
      { slug: 'a', enabled: true },
      { slug: 'b', enabled: false },
      { slug: 'c', enabled: true },
    ];
    const selected = new Set(['a', 'b']);
    expect(bulkTargets(triggers, selected, false).map((t) => t.slug)).toEqual(['a']);
    expect(bulkTargets(triggers, selected, true).map((t) => t.slug)).toEqual(['b']);
  });
});

describe('runSequentially', () => {
  test('one at a time, in order, tallying failures without throwing', async () => {
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const progress: [number, number][] = [];
    const tally = await runSequentially(
      ['a', 'b', 'c'],
      async (slug) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        seen.push(slug);
        inFlight -= 1;
        if (slug === 'b') throw new Error('409');
      },
      (done, total) => progress.push([done, total]),
    );
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(maxInFlight).toBe(1);
    expect(tally).toEqual({ ok: 2, failed: 1, errors: ['409'], cancelled: false });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe('runSequentially cancellation and the visible selection', () => {
  test('a cancelled run stops between items and says so', async () => {
    let calls = 0;
    const tally = await runSequentially(
      ['a', 'b', 'c'],
      async () => {
        calls += 1;
      },
      undefined,
      () => calls >= 1,
    );
    expect(calls).toBe(1);
    expect(tally).toEqual({ ok: 1, failed: 0, errors: [], cancelled: true });
  });
  test('bulk actions act only on selected rows the filter and search still show', () => {
    expect([...visibleSelection([{ slug: 'a' }, { slug: 'c' }], new Set(['a', 'b']))]).toEqual([
      'a',
    ]);
  });
});

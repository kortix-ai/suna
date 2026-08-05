import { describe, expect, test } from 'bun:test';

import {
  estimateRowHeight,
  readSnapshot,
  resolveScrollMargin,
  translateForItem,
  writeSnapshot,
} from './virtual-list-core';

describe('translateForItem', () => {
  // virtual-core builds item coordinates seeded with `scrollMargin`
  // (virtual-core/index.js:645) but `getTotalSize` subtracts it back out
  // (:1063), so the container never carries the lead-in. react-virtual's own
  // helper documents the companion formula: `item.start - scrollMargin`.
  //
  // PR #6104 used a bare `translateY(virtualRow.start)`. That is correct ONLY
  // while scrollMargin is 0 — which it was, because the PR never set it. The
  // moment the margin is real, a bare `start` pushes every row down by it.
  test('subtracts the scroll margin from the item start', () => {
    expect(translateForItem(1000, 45)).toBe(955);
  });

  test('is the identity when there is no lead-in', () => {
    expect(translateForItem(1000, 0)).toBe(1000);
  });

  test('never returns a negative offset', () => {
    expect(translateForItem(10, 45)).toBe(0);
  });
});

describe('resolveScrollMargin', () => {
  // The transcript's virtualized container sits below the content wrapper's
  // py-6, the load-older block and the optimistic turn. Measured live: 22px in
  // one session, 45px in another, and it GROWS while older history loads.
  const rect = (top: number) => ({ top }) as DOMRect;

  test('is the container offset from the scroller content top', () => {
    expect(
      resolveScrollMargin({
        containerRect: rect(155),
        scrollerRect: rect(110),
        scrollTop: 0,
      }),
    ).toBe(45);
  });

  test('adds the current scrollTop so the value is scroll-independent', () => {
    // Same DOM, reader scrolled 900px down: the margin is still 45.
    expect(
      resolveScrollMargin({
        containerRect: rect(-745),
        scrollerRect: rect(110),
        scrollTop: 900,
      }),
    ).toBe(45);
  });

  test('never returns a negative margin', () => {
    expect(
      resolveScrollMargin({ containerRect: rect(0), scrollerRect: rect(110), scrollTop: 0 }),
    ).toBe(0);
  });

  test('rounds to a whole pixel so sub-pixel jitter cannot re-trigger a layout pass', () => {
    expect(
      resolveScrollMargin({
        containerRect: rect(132.078125),
        scrollerRect: rect(110),
        scrollTop: 0,
      }),
    ).toBe(22);
  });
});

describe('estimateRowHeight', () => {
  // PR #6104 used one 600px constant for every item, against turns measured at
  // 17,944px. getTotalSize was short by (real - 600) for every unmounted item,
  // so the scrollbar rescaled continuously and the initial
  // `scrollTop = scrollHeight - 300` restore aimed at a phantom height.
  // Per-kind estimates come from the measured distribution instead.
  test('estimates a segment from the measured median, not a turn-sized guess', () => {
    const estimate = estimateRowHeight({ kind: 'segment' });

    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(120);
  });

  test('estimates a head row taller than a segment', () => {
    expect(estimateRowHeight({ kind: 'turn-head' })).toBeGreaterThan(
      estimateRowHeight({ kind: 'segment' }),
    );
  });

  // Every kind the row model can emit needs an estimate. A missing one would
  // fall through to `undefined`, and virtual-core would size that row NaN.
  test('gives every row kind a positive estimate', () => {
    for (const kind of ['turn-single', 'turn-head', 'segment', 'turn-tail'] as const) {
      expect(estimateRowHeight({ kind })).toBeGreaterThan(0);
    }
  });
});

describe('snapshot', () => {
  // virtual-core 3.17.3 exposes `takeSnapshot()`, which returns exactly the
  // VirtualItem[] that `initialMeasurementsCache` expects (index.d.ts:188).
  // We carry it verbatim rather than reconstructing `start` ourselves — the
  // library already accounts for padding and lanes, and a hand-rolled running
  // total would silently disagree with it.
  //
  // PR #6104 supplied neither `initialOffset` nor `initialMeasurementsCache`,
  // so every remount re-estimated the whole transcript from its 600px constant.
  const item = (key: string, index: number, start: number, size: number) => ({
    key,
    index,
    start,
    end: start + size,
    size,
    lane: 0,
  });

  test('round-trips the offset and the measured items verbatim', () => {
    const items = [item('u1:seg:p0', 0, 0, 20), item('u1:seg:p1', 1, 20, 487)];
    const snap = writeSnapshot({ offset: 17299, items, sessionId: 's1' });

    const restored = readSnapshot(snap, 's1');

    expect(restored?.offset).toBe(17299);
    expect(restored?.measurements).toEqual(items);
  });

  test('survives a structured-clone round trip, so it can be persisted', () => {
    const snap = writeSnapshot({
      offset: 42,
      items: [item('a', 0, 0, 10)],
      sessionId: 's1',
    });

    const revived = JSON.parse(JSON.stringify(snap));

    expect(readSnapshot(revived, 's1')?.measurements).toEqual(snap.measurements);
  });

  test('reads back nothing when there is no snapshot', () => {
    expect(readSnapshot(undefined, 's1')).toBeNull();
  });

  // A snapshot taken against a different session must not seed this one's
  // cache — keys are prefixed with a turn id, so a stale entry would mis-size
  // a row rather than being ignored.
  test('drops a snapshot that belongs to another session', () => {
    const snap = writeSnapshot({ offset: 10, items: [], sessionId: 'a' });

    expect(readSnapshot(snap, 'b')).toBeNull();
    expect(readSnapshot(snap, 'a')?.offset).toBe(10);
  });

  // An empty measurement list is a real state (nothing rendered yet). It must
  // not be confused with "no snapshot", or a restore would silently no-op.
  test('restores an offset even when nothing was measured yet', () => {
    const snap = writeSnapshot({ offset: 300, items: [], sessionId: 's1' });

    expect(readSnapshot(snap, 's1')).toEqual({ offset: 300, measurements: [] });
  });
});

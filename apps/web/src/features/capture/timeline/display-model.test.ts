import { describe, expect, test } from 'bun:test';

import {
  activeDisplayAt,
  coveredAt,
  displayLayout,
  liveState,
  recordedSince,
  type ScreenItem,
} from './display-model';

const MIN = 60_000;
const focus = [
  { display_id: 1, s: 0, e: 5 * MIN },
  { display_id: 2, s: 5 * MIN + 2_000, e: 9 * MIN },
];

describe('the active display', () => {
  test('is the display holding focus at the playhead, the last one before a gap, and null before any', () => {
    expect(activeDisplayAt(focus, 2 * MIN, 2_000)).toBe(1);
    expect(activeDisplayAt(focus, 7 * MIN, 2_000)).toBe(2);
    // Between spans (2 s seam): the span that just ended.
    expect(activeDisplayAt(focus, 5 * MIN + 1_000, 2_000)).toBe(1);
    expect(activeDisplayAt(focus, 30 * MIN, 2_000)).toBe(2);
    expect(activeDisplayAt(focus, -1, 2_000)).toBeNull();
    expect(activeDisplayAt([], 1, 2_000)).toBeNull();
  });
});

describe('recorded or not', () => {
  const items: ScreenItem[] = [
    { display_id: 1, s: 0, e: 5 * MIN },
    { display_id: 2, s: 0, e: 10 * MIN },
  ];
  test('a playhead inside a screen item of the display is recorded, even with no frame near it (a still screen)', () => {
    expect(coveredAt(items, 4 * MIN, 1)).toBe(true);
    expect(coveredAt(items, 7 * MIN, 1)).toBe(false);
    expect(coveredAt(items, 7 * MIN, 2)).toBe(true);
    // No display asked (a one-display device): any screen item.
    expect(coveredAt(items, 7 * MIN, null)).toBe(true);
    expect(coveredAt(items, 11 * MIN, null)).toBe(false);
  });
});

describe('recorded from a frame', () => {
  test('a display is recorded from a frame until its next one, for at most the 30 s keep-alive and one 2 s tick', () => {
    expect(recordedSince(0, 31_000)).toBe(true);
    expect(recordedSince(0, 32_000)).toBe(true);
    expect(recordedSince(0, 32_001)).toBe(false);
    expect(recordedSince(null, 1)).toBe(false);
  });
});

describe('Live', () => {
  const now = 1_000 * MIN;
  test('recording and behind the device: uploading, with how far behind', () => {
    expect(
      liveState({
        status: 'recording',
        lastFrameMs: now - 1_000,
        newestIndexedMs: now - 90_000,
        now,
      }),
    ).toEqual({
      kind: 'uploading',
      behindMs: 90_000,
    });
  });
  test('recording and caught up: live', () => {
    expect(
      liveState({
        status: 'recording',
        lastFrameMs: now - 3_000,
        newestIndexedMs: now - 2_000,
        now,
      }),
    ).toEqual({ kind: 'live', behindMs: 2_000 });
  });
  test('recording with nothing indexed yet: uploading', () => {
    expect(
      liveState({ status: 'recording', lastFrameMs: now, newestIndexedMs: null, now }).kind,
    ).toBe('uploading');
  });
  test('not recording: the device status says why', () => {
    expect(
      liveState({ status: 'paused', lastFrameMs: now - MIN, newestIndexedMs: now - 5 * MIN, now })
        .kind,
    ).toBe('paused');
    expect(
      liveState({ status: 'offline', lastFrameMs: null, newestIndexedMs: now - 5 * MIN, now }).kind,
    ).toBe('offline');
    expect(
      liveState({ status: 'permission', lastFrameMs: null, newestIndexedMs: null, now }).kind,
    ).toBe('permission');
  });
});

describe('the layout of all displays', () => {
  test('keeps the displays where they sit relative to each other, scaled to fit, centred', () => {
    const rects = displayLayout(
      [
        { id: 1, x: 0, y: 0, w: 1500, h: 1000 },
        { id: 2, x: 1500, y: -200, w: 1500, h: 1000 },
      ],
      600,
      300,
    );
    // 3000 x 1200 points into 600 x 300: scale 0.2, so 600 x 240, centred vertically (30 px top).
    expect(rects).toEqual([
      { id: 1, left: 0, top: 70, width: 300, height: 200 },
      { id: 2, left: 300, top: 30, width: 300, height: 200 },
    ]);
  });
});

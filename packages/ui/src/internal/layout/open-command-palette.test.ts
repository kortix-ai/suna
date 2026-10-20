import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  consumePendingCommandPalette,
  OPEN_COMMAND_PALETTE_EVENT,
  openCommandPalette,
} from './open-command-palette';

// ─── Minimal DOM stub ───────────────────────────────────────────────────────
// This package has no jsdom/happy-dom dependency (see action-navigator-logic
// .test.ts for the same constraint handled the same way). `openCommandPalette`
// only needs `window` to be an event target, which EventTarget already is.
const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = new EventTarget();
afterAll(() => {
  if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = realWindow;
});

describe('openCommandPalette', () => {
  beforeEach(() => {
    consumePendingCommandPalette();
  });

  test('dispatches the event the palette listens for', () => {
    let seen = 0;
    const onOpen = () => seen++;
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    openCommandPalette();
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    expect(seen).toBe(1);
  });

  // The regression this exists for: the search button paints before the
  // palette's lazy chunk loads, so a click in that window dispatches to no
  // listener. Confirmed broken in the browser before the buffer was added.
  test('buffers a request made while nothing is listening', () => {
    openCommandPalette();
    expect(consumePendingCommandPalette()).toBe(true);
  });

  test('the buffered request is consumed exactly once', () => {
    openCommandPalette();
    expect(consumePendingCommandPalette()).toBe(true);
    // A later remount of the palette must not re-open itself off a stale flag.
    expect(consumePendingCommandPalette()).toBe(false);
  });

  test('reports nothing pending when no one asked', () => {
    expect(consumePendingCommandPalette()).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BUSY_INDICATOR_HANDOVER_MS,
  createBusyEnterPresence,
  noteBusyIndicatorMounted,
  noteBusyIndicatorUnmounted,
  SessionBusyIndicator,
  shouldAnimateBusyEnter,
} from './session-busy-indicator';

describe('SessionBusyIndicator', () => {
  test('falls back to Thinking with no props', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator />);
    expect(markup).toContain('Thinking');
  });

  test('starts the default Thinking shimmer at its sweep origin', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator />);
    expect(markup).toContain('background-position:100% center');
  });

  test('renders the supplied status text', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator statusText="Running tests" />);
    expect(markup).toContain('Running tests');
    expect(markup).not.toContain('Thinking');
  });

  test('falls back to Thinking for whitespace-only status text', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator statusText="   " />);
    expect(markup).toContain('Thinking');
  });

  test('retryLabel wins over statusText and suppresses the shimmer', () => {
    const markup = renderToStaticMarkup(
      <SessionBusyIndicator statusText="Running tests" retryLabel="Waiting to retry" />,
    );
    expect(markup).toContain('Waiting to retry');
    expect(markup).not.toContain('Running tests');
    expect(markup).not.toContain('bg-clip-text');
  });

  test('omitting elapsed renders no trailing element', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator />);
    expect(markup).not.toContain('tabular-nums');
  });

  test('ambient without status cycles a filler line, not Thinking', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator ambient />);
    expect(markup).not.toContain('>Thinking<');
    expect(markup).toContain('bg-clip-text');
  });

  test('statusText wins over ambient', () => {
    const markup = renderToStaticMarkup(
      <SessionBusyIndicator ambient statusText="Running tests" />,
    );
    expect(markup).toContain('Running tests');
  });

  // Regression: the elapsed counter used to be concatenated into `statusText`,
  // so the animated span's key changed once a second and replayed the roll-swap
  // for the whole of any long tool call. The phrase markup either side of the
  // elapsed span must stay byte-identical as the clock ticks.
  test('elapsed time ticks without changing the animated phrase', () => {
    const at21 = renderToStaticMarkup(
      <SessionBusyIndicator statusText="Running tests" elapsedLabel="21s" />,
    );
    const at22 = renderToStaticMarkup(
      <SessionBusyIndicator statusText="Running tests" elapsedLabel="22s" />,
    );
    expect(at21).toContain('21s');
    expect(at22).toContain('22s');
    expect(at21).toContain('tabular-nums');
    expect(at21.replace('21s', 'X')).toBe(at22.replace('22s', 'X'));
  });

  test('omitting elapsedLabel renders no separator', () => {
    const markup = renderToStaticMarkup(<SessionBusyIndicator statusText="Thinking" />);
    expect(markup).not.toContain('&middot;');
  });

  // The ambient phrases rotate on a 4s timer and carry no information, so the
  // live region is muted for them; a real status still announces.
  test('ambient mutes the live region, real status announces', () => {
    expect(renderToStaticMarkup(<SessionBusyIndicator ambient />)).toContain('aria-live="off"');
    expect(renderToStaticMarkup(<SessionBusyIndicator statusText="Running tests" />)).toContain(
      'aria-live="polite"',
    );
  });
});

/**
 * The waiting row changes mount point as a session starts: the boot shell's
 * stand-in, the chat's stand-in, the trailing row, then the turn's own. Each
 * move unmounts one instance and mounts another, and the new one replayed its
 * enter animation every time — the row blinked at exactly the moments the user
 * is watching it hardest.
 */
describe('shouldAnimateBusyEnter — a handover is not a new row', () => {
  function after(unmountAtMs: number | null) {
    const presence = createBusyEnterPresence();
    if (unmountAtMs !== null) {
      noteBusyIndicatorMounted(unmountAtMs - 1, presence);
      noteBusyIndicatorUnmounted(unmountAtMs, presence);
    }
    return presence;
  }

  test('the first row of a session animates in', () => {
    expect(shouldAnimateBusyEnter(10_000, createBusyEnterPresence())).toBe(true);
  });

  test('a row that re-mounts in the same frame starts settled', () => {
    expect(shouldAnimateBusyEnter(10_000, after(10_000))).toBe(false);
  });

  test('a handover just inside the window starts settled', () => {
    expect(
      shouldAnimateBusyEnter(10_000, after(10_000 - (BUSY_INDICATOR_HANDOVER_MS - 1))),
    ).toBe(false);
  });

  test('a mount one whole enter duration after the last one animates', () => {
    expect(shouldAnimateBusyEnter(10_000, after(10_000 - BUSY_INDICATOR_HANDOVER_MS))).toBe(true);
  });

  test('a first row after a long idle animates', () => {
    expect(shouldAnimateBusyEnter(60_000, after(10_000))).toBe(true);
  });

  // A clock that jumped backwards must never be read as a long idle: settled is
  // the outcome that cannot blink.
  test('a stamp in the future starts settled', () => {
    expect(shouldAnimateBusyEnter(10_000, after(12_000))).toBe(false);
  });
});

/**
 * The handovers R4 names happen in ONE commit: the stand-in row and the turn's
 * own row swap as `turns.length` goes 0 → 1, and the trailing fallback row
 * swaps into a turn. React renders the mounting tree BEFORE it runs the deleted
 * tree's passive cleanups, so a mount-time read that only knows about unmounts
 * reads the state from before the outgoing row left — `null` on the first
 * handover of a page load — and animates exactly where it must not.
 *
 * `apps/web` has no DOM harness, so these drive the module's own presence
 * counter in the order React drives it: render (read), then the commit's
 * cleanups, then the commit's mount effects.
 */
describe('a same-commit handover starts settled', () => {
  test('a row mounting while the outgoing row is still counted starts settled', () => {
    const presence = createBusyEnterPresence();

    // Commit 1: the stand-in row is the first row of the page load.
    expect(shouldAnimateBusyEnter(1_000, presence)).toBe(true);
    noteBusyIndicatorMounted(1_000, presence);

    // Commit 2: `turns.length` goes 0 → 1. The turn's row renders first, then
    // the stand-in's cleanup runs, then the turn's row mounts.
    expect(shouldAnimateBusyEnter(1_050, presence)).toBe(false);
    noteBusyIndicatorUnmounted(1_050, presence);
    noteBusyIndicatorMounted(1_050, presence);

    expect(presence.live).toBe(1);
  });

  test('a row mounting after the outgoing row already left starts settled', () => {
    const presence = createBusyEnterPresence();
    noteBusyIndicatorMounted(1_000, presence);
    noteBusyIndicatorUnmounted(1_100, presence);

    // Separate commits, inside the enter window: still one row moving.
    expect(shouldAnimateBusyEnter(1_120, presence)).toBe(false);
  });

  test('the next turn after an idle gap animates', () => {
    const presence = createBusyEnterPresence();
    noteBusyIndicatorMounted(1_000, presence);
    noteBusyIndicatorUnmounted(1_100, presence);

    expect(shouldAnimateBusyEnter(1_100 + BUSY_INDICATOR_HANDOVER_MS, presence)).toBe(true);
  });

  // Dev StrictMode mounts, cleans up, and mounts again. The count has to come
  // back to one, or every later row reads a phantom live row and never animates.
  test('a double mount leaves the live count balanced', () => {
    const presence = createBusyEnterPresence();
    noteBusyIndicatorMounted(1_000, presence);
    noteBusyIndicatorUnmounted(1_000, presence);
    noteBusyIndicatorMounted(1_000, presence);
    expect(presence.live).toBe(1);

    noteBusyIndicatorUnmounted(1_000, presence);
    expect(presence.live).toBe(0);
    // Never negative: an unbalanced cleanup must not make every later mount
    // animate by underflowing the count.
    noteBusyIndicatorUnmounted(1_000, presence);
    expect(presence.live).toBe(0);
  });
});

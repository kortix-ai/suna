import { describe, expect, test } from 'bun:test';
import {
  OLDER_AUTOLOAD_MAX_PAGES,
  olderAutoloadExhausted,
  shouldLoadOlderHistory,
} from './session-older-autoload';

const IN_VIEW = {
  isIntersecting: true,
  hasOlder: true,
  isLoadingOlder: false,
  lastPullFailed: false,
};

describe('older-history autoload', () => {
  // A transcript never sheds what it pulls: turns stay in the DOM, their parts
  // stay in the sync store, and their images keep decoded bitmaps alive. Left
  // uncapped, idle scrolling walks a long thread's whole history into memory —
  // the retention behind a tab Chrome discards and reloads on its own. Reading
  // further back stays possible; it just stops being something a scroll does by
  // itself.
  test('stops pulling by itself once the auto-load budget is spent', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, autoLoadedPages: OLDER_AUTOLOAD_MAX_PAGES })).toBe(
      false,
    );
    expect(
      shouldLoadOlderHistory({ ...IN_VIEW, autoLoadedPages: OLDER_AUTOLOAD_MAX_PAGES - 1 }),
    ).toBe(true);
  });

  test('an explicit pull is never budgeted — only the sentinel is', () => {
    // The manual control calls `loadOlder` directly; the budget lives on the
    // automatic path so a reader who asks for more always gets it.
    expect(olderAutoloadExhausted({ hasOlder: true, autoLoadedPages: OLDER_AUTOLOAD_MAX_PAGES })).toBe(
      true,
    );
    expect(olderAutoloadExhausted({ hasOlder: false, autoLoadedPages: 99 })).toBe(false);
    expect(olderAutoloadExhausted({ hasOlder: true, autoLoadedPages: 0 })).toBe(false);
  });

  test('a missing budget behaves like a fresh session, not like an exhausted one', () => {
    expect(shouldLoadOlderHistory(IN_VIEW)).toBe(true);
  });

  test('pulls the previous page once the top sentinel comes into view', () => {
    expect(shouldLoadOlderHistory(IN_VIEW)).toBe(true);
  });

  test('does not pull while the sentinel is out of view', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, isIntersecting: false })).toBe(false);
  });

  test('does not pull at the start of history', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, hasOlder: false })).toBe(false);
  });

  test('does not pull a second page while the first is in flight', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, isLoadingOlder: true })).toBe(false);
  });

  // Without this the observer re-arms on every state change and a failing
  // cursor turns into an unbounded request loop against the runtime — the
  // failure mode the manual button structurally could not have.
  test('stops auto-pulling after a failed pull, until an explicit retry', () => {
    expect(shouldLoadOlderHistory({ ...IN_VIEW, lastPullFailed: true })).toBe(false);
  });
});

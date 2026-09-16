'use client';

import { create } from 'zustand';

/**
 * Which session row's brief is showing, for the whole sidebar at once.
 *
 * Radix HoverCard has no group concept — each instance owns its own delays and
 * knows nothing about its siblings — so moving between two rows played out as
 * "row A closes after 100ms, row B opens after 200ms": the card vanished and
 * came back somewhere else. `Tooltip.Provider` solves this with
 * `skipDelayDuration`; HoverCard has no equivalent, and it exports no `Anchor`,
 * so a single repositioning instance is not available either. One store holding
 * the active row is what is left, and it is also the cheaper shape: exactly one
 * card is mounted at any time, by construction rather than by timing luck.
 *
 * The delays live here rather than on the primitive for a performance reason.
 * If `openDelay` were a prop derived from `warm`, every row in the sidebar would
 * re-render each time the group warmed or cooled. Nothing selects `warm`, so it
 * changes without rendering anything; rows select the boolean
 * `activeSessionId === id`, which flips for exactly two rows per move.
 */

/** The first card costs a delay, so a pointer crossing the list on its way
 *  somewhere else does not flash open every row it passes over. */
export const HOVER_OPEN_DELAY_MS = 500;
/** Moving to the next row while a card is open. Short, never zero: at zero,
 *  sweeping down a long list opened and rendered a card for every row. The
 *  open card stays up during this delay, so the card still reads as moving. */
export const HOVER_WARM_OPEN_DELAY_MS = 150;
/** How long after the last scroll event no card may open. */
export const HOVER_SCROLL_SUPPRESS_MS = 200;
/** Long enough for the pointer to cross the `sideOffset` gap into the card. */
export const HOVER_CLOSE_DELAY_MS = 100;
/** How long the group stays warm after its last card closes. */
export const HOVER_WARM_GRACE_MS = 300;

/**
 * Once one card is open the group is warm and the next row opens after a short
 * delay while the current card stays up, so the card reads as moving to the row
 * under the pointer instead of closing and reopening.
 */
export function hoverOpenDelayMs(warm: boolean): number {
  return warm ? HOVER_WARM_OPEN_DELAY_MS : HOVER_OPEN_DELAY_MS;
}

/**
 * Compare-and-clear, the same guard `session-switch-store` uses: a close
 * scheduled for an older row must never close the card that has replaced it.
 */
export function clearIfActive(current: string | null, sessionId: string): string | null {
  return current === sessionId ? null : current;
}

interface SessionHoverState {
  activeSessionId: string | null;
  /** Deliberately unselected by any component — see the note above. */
  warm: boolean;
  openSession: (sessionId: string) => void;
  closeSession: (sessionId: string) => void;
  /** Immediate, for a click that opens something else and for unmount. */
  dismiss: () => void;
}

let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let warmTimer: ReturnType<typeof setTimeout> | null = null;
/** No card opens before this instant (epoch ms); see `suppressSessionHoverWhileScrolling`. */
let suppressedUntil = 0;

function cancel(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

export const useSessionHoverStore = create<SessionHoverState>((set, get) => ({
  activeSessionId: null,
  warm: false,

  openSession: (sessionId) => {
    closeTimer = cancel(closeTimer);
    warmTimer = cancel(warmTimer);
    // A pending open belongs to whichever row the pointer has just left.
    openTimer = cancel(openTimer);

    // Re-entering the row that is already showing must not restart anything,
    // or crossing the gap back from the card would flicker it.
    if (get().activeSessionId === sessionId) return;
    // Rows slide under a still pointer while the list scrolls.
    if (Date.now() < suppressedUntil) return;

    openTimer = setTimeout(() => {
      openTimer = null;
      if (Date.now() < suppressedUntil) return;
      set({ activeSessionId: sessionId, warm: true });
    }, hoverOpenDelayMs(get().warm));
  },

  closeSession: (sessionId) => {
    openTimer = cancel(openTimer);
    closeTimer = cancel(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      set((state) => ({ activeSessionId: clearIfActive(state.activeSessionId, sessionId) }));
      warmTimer = setTimeout(() => {
        warmTimer = null;
        set({ warm: false });
      }, HOVER_WARM_GRACE_MS);
    }, HOVER_CLOSE_DELAY_MS);
  },

  dismiss: () => {
    openTimer = cancel(openTimer);
    closeTimer = cancel(closeTimer);
    warmTimer = cancel(warmTimer);
    set({ activeSessionId: null, warm: false });
  },
}));

/**
 * The session list's scroll handler. Scrolling moves rows under a pointer that
 * has not moved, and each one fires pointer-enter: without this, a scroll
 * opened (and rendered) a brief card for row after row. Closes the open card,
 * cancels a pending open, and blocks opens until scrolling has been quiet for
 * `HOVER_SCROLL_SUPPRESS_MS`. Cheap enough for every scroll event: no state
 * write unless a card is actually open.
 */
export function suppressSessionHoverWhileScrolling(): void {
  suppressedUntil = Date.now() + HOVER_SCROLL_SUPPRESS_MS;
  openTimer = cancel(openTimer);
  if (useSessionHoverStore.getState().activeSessionId) useSessionHoverStore.getState().dismiss();
}

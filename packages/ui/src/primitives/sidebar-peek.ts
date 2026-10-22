export const SIDEBAR_PEEK_OPEN_DELAY_MS = 100;
export const SIDEBAR_PEEK_CLOSE_DELAY_MS = 250;

type TimerId = ReturnType<typeof setTimeout>;

export interface PeekController {
  enter: () => void;
  leave: () => void;
  cancel: () => void;
  /**
   * Hold the flyout open across pointer-leaves — used while a menu/popover
   * anchored in the panel is open. Its content portals outside the panel, so
   * moving the pointer onto it fires the panel's `leave` and would otherwise
   * arm the close timer. Calls must be balanced: `hold(true)` on open,
   * `hold(false)` on close. On the final release the close timer is armed
   * unless `isPointerOver()` reports the pointer is back on the panel.
   */
  hold: (held: boolean, isPointerOver?: () => boolean) => void;
}

/**
 * Hover intent for the collapsed sidebar's edge-peek flyout. `enter` arms the
 * open delay (grazing the edge must not flash the panel), `leave` arms the
 * close delay (the pointer needs time to travel from the edge zone onto the
 * panel), and re-entering during a pending close keeps the panel up. `cancel`
 * drops the peek immediately — used when the sidebar docks open, the viewport
 * goes mobile, or the provider unmounts.
 */
export function createPeekController(
  setPeek: (peek: boolean) => void,
  schedule: (fn: () => void, ms: number) => TimerId = setTimeout,
  unschedule: (id: TimerId) => void = clearTimeout,
): PeekController {
  let timer: TimerId | null = null;
  let peeked = false;
  // Number of menus/popovers currently pinning the flyout open. While > 0 a
  // `leave` cannot close the panel; the last release re-arms the close timer.
  let holds = 0;

  const clear = () => {
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
  };

  const armClose = () => {
    clear();
    if (!peeked) return;
    timer = schedule(() => {
      timer = null;
      peeked = false;
      setPeek(false);
    }, SIDEBAR_PEEK_CLOSE_DELAY_MS);
  };

  return {
    enter: () => {
      clear();
      if (peeked) return;
      timer = schedule(() => {
        timer = null;
        peeked = true;
        setPeek(true);
      }, SIDEBAR_PEEK_OPEN_DELAY_MS);
    },
    leave: () => {
      if (holds > 0) return;
      armClose();
    },
    cancel: () => {
      clear();
      holds = 0;
      if (!peeked) return;
      peeked = false;
      setPeek(false);
    },
    hold: (held, isPointerOver) => {
      if (held) {
        holds += 1;
        // Cancel any close armed by the leave that fired as the pointer
        // travelled from the panel onto the portaled menu content.
        clear();
        return;
      }
      holds = Math.max(0, holds - 1);
      if (holds === 0 && !isPointerOver?.()) armClose();
    },
  };
}

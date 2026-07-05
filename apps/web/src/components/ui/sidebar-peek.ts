export const SIDEBAR_PEEK_OPEN_DELAY_MS = 100;
export const SIDEBAR_PEEK_CLOSE_DELAY_MS = 250;

type TimerId = ReturnType<typeof setTimeout>;

export interface PeekController {
  enter: () => void;
  leave: () => void;
  cancel: () => void;
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

  const clear = () => {
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
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
      clear();
      if (!peeked) return;
      timer = schedule(() => {
        timer = null;
        peeked = false;
        setPeek(false);
      }, SIDEBAR_PEEK_CLOSE_DELAY_MS);
    },
    cancel: () => {
      clear();
      if (!peeked) return;
      peeked = false;
      setPeek(false);
    },
  };
}

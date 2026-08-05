/**
 * "Put THIS turn at the top of the viewport, once it exists."
 *
 * The send path used to do:
 *
 *     scrollToBottom();
 *     setTimeout(() => scrollToBottom(), 100);
 *
 * with the comment "again after the turn likely rendered". **Likely** is the
 * bug. `100` is a guess at render time, both calls fire at send time, and the
 * thing they scroll to is "the last `[data-turn-id]`" — so if the new turn is
 * not in the DOM yet, both anchor the PREVIOUS turn and the real one lands
 * wherever it lands. On a slow render, or when the turn arrives late, the
 * viewport then moves with nothing having asked it to.
 *
 * This waits for the specific element instead of guessing, and gives up rather
 * than fighting a reader who has taken over.
 *
 * Framework-free and DOM-free on purpose: `find`, `anchor` and `schedule` are
 * injected, so the retry/cancel lifecycle is directly testable without a
 * browser — which matters here, because a scroll bug that only appears on a
 * slow render is not something a render test would catch either.
 */

export interface TurnAnchorDeps<TElement> {
  /** The turn's element, or null while it has not rendered yet. */
  find: (turnId: string) => TElement | null;
  /** Put it where it belongs. Called at most once per request. */
  anchor: (element: TElement) => void;
  /** Run `fn` on the next frame; the returned function cancels it. */
  schedule: (fn: () => void) => () => void;
}

export interface TurnAnchorOptions {
  /**
   * How many frames to wait for the element before giving up. ~30 frames is
   * half a second at 60fps — long enough for a slow React commit, short enough
   * that a turn which never arrives does not leave a scroll primed to fire
   * into a viewport the reader has since moved on from.
   */
  maxFrames?: number;
}

export interface TurnAnchor {
  /**
   * Anchor `turnId` as soon as it exists. Supersedes any pending request —
   * two sends in quick succession should land on the second, not fight.
   */
  request: (turnId: string) => void;
  /**
   * The reader took over. Abandon the pending anchor.
   *
   * This is the half the old code had no way to express: a `setTimeout` that
   * has already been queued will fire into whatever the viewport looks like
   * 100ms later, including one the reader deliberately scrolled away.
   */
  abandon: () => void;
}

const DEFAULT_MAX_FRAMES = 30;

export function createTurnAnchor<TElement>(
  deps: TurnAnchorDeps<TElement>,
  options: TurnAnchorOptions = {},
): TurnAnchor {
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  let cancelPending: (() => void) | null = null;

  const abandon = () => {
    cancelPending?.();
    cancelPending = null;
  };

  const request = (turnId: string) => {
    abandon();

    let frames = 0;
    const attempt = () => {
      cancelPending = null;
      const element = deps.find(turnId);
      if (element !== null) {
        deps.anchor(element);
        return;
      }
      frames += 1;
      if (frames >= maxFrames) return;
      cancelPending = deps.schedule(attempt);
    };

    // Try synchronously first: when the turn is already committed — the common
    // case — this anchors in the same frame the user pressed enter, with no
    // wait and no intermediate position to see.
    attempt();
  };

  return { request, abandon };
}

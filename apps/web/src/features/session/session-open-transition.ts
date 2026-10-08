/**
 * The project-home composer → new session hand-off, drawn as one dissolve.
 *
 * Without it the hand-off was a cut, and on the production build a double one.
 * The route prefetch for a session stops at the first `loading.tsx` from the
 * top (Next's prefetching guide: "Layout to first loading boundary"), which is
 * `projects/[id]/loading.tsx` — the pulsing Kortix mark. So Enter painted the
 * home page, then the mark for one server round trip (88 ms measured), then
 * the session: heading, dot wallpaper and the hero composer in the middle of
 * the page swapped for the header, the user's bubble at the top and a composer
 * docked at the bottom, in single frames.
 *
 * The departing page is torn down by the route change, so nothing on it can
 * fade out by itself. So the home page leaves a copy of itself on its way out:
 * when it unmounts while a session it sent is opening, `useSessionOpenSource`
 * clones its pane into a fixed, inert layer at the same rectangle — in the same
 * commit that removes it, so no frame shows the gap — and that layer dissolves
 * once the new session's first surface is in the DOM. Whatever the route paints
 * in between (the mark) stays under the copy.
 *
 * Only ONE layer animates: the copy fades out over the live page. Opacity only,
 * so it is its own reduced-motion variant (`motion.md`). The copy is live DOM,
 * so the send spinner in it keeps turning — a View Transition would have held a
 * frozen screenshot for the whole round trip instead.
 */

import { type RefObject, useLayoutEffect } from 'react';

/** Longest the copy may stand in for a route that has not mounted yet. */
export const SURFACE_WAIT_MS = 2000;

/**
 * Longest a hand-off may wait for the home page to unmount. Generous on
 * purpose: a cold dev server compiles the session route on its first hit, and
 * the unmount came 5.3 s after the send there (4.35 s for the route alone). The
 * destination check in `leaveSessionOpenGhost` is what keeps a stale hand-off
 * from covering the wrong page; this only bounds how long one is remembered.
 */
const PENDING_TTL_MS = 60_000;

/** Fallback for `transitionend`, which never fires in a hidden tab. */
const FADE_FALLBACK_MS = 350;

/** The attribute the dissolving copy carries (`globals.css`). */
export const SESSION_OPEN_GHOST_ATTRIBUTE = 'data-session-open-ghost';

/** Marks the root element of a session's first surface. */
export const SESSION_SURFACE_ATTRIBUTE = 'data-session-surface';

interface PendingOpen {
  sessionId: string;
  at: number;
  /** The source pane's canvases as they last drew, in document order. */
  canvases: Array<HTMLCanvasElement | null>;
}

let pending: PendingOpen | null = null;
/** The page a hand-off would dissolve out of (`useSessionOpenSource`). */
let source: HTMLElement | null = null;

/**
 * Copies every canvas in `pane` into a 2D canvas of the same size.
 *
 * Call it from an animation-frame callback. The project home's wallpaper is a
 * WebGL/WebGPU shader with no `preserveDrawingBuffer`, so its pixels are only
 * readable in the frame that drew them: a copy taken there carries the dots
 * (alpha sum 256,810,500 measured), the same copy from a timer or from the
 * unmount reads blank (0). `cloneNode` copies the element, never the pixels.
 */
export function snapshotCanvases(pane: ParentNode): Array<HTMLCanvasElement | null> {
  return Array.from(pane.querySelectorAll('canvas')).map((canvas) => {
    if (canvas.width === 0 || canvas.height === 0) return null;
    try {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext('2d')?.drawImage(canvas, 0, 0);
      return copy;
    } catch {
      return null;
    }
  });
}

/** Called right before the composer's navigation into `sessionId`. */
export function markSessionOpening(sessionId: string, now = Date.now()): void {
  const opening: PendingOpen = { sessionId, at: now, canvases: [] };
  pending = opening;
  const pane = source;
  if (!pane || typeof requestAnimationFrame === 'undefined') return;
  // The shader's own frame callback was queued first, so this one reads the
  // frame it just drew. The navigation commits a frame or more later.
  requestAnimationFrame(() => {
    if (pending === opening) opening.canvases = snapshotCanvases(pane);
  });
}

/** The hand-off in flight, consumed: one unmount leaves one copy. */
export function takeSessionOpening(now = Date.now()): PendingOpen | null {
  const current = pending;
  pending = null;
  if (!current || now - current.at > PENDING_TTL_MS) return null;
  return current;
}

/**
 * Resolves once `isMounted()` is true: checked now, then on every DOM change,
 * and unconditionally after `timeoutMs`.
 */
export function waitForSurface(
  isMounted: () => boolean,
  timeoutMs: number,
  observe: (onChange: () => void) => () => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (isMounted()) {
      resolve();
      return;
    }
    let stop = () => {};
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    stop = observe(() => {
      if (isMounted()) done();
    });
  });
}

/** `/…/sessions/<id>`, under any locale prefix. */
export function isSessionPath(pathname: string, sessionId: string): boolean {
  return pathname.replace(/\/+$/, '').endsWith(`/sessions/${sessionId}`);
}

export function sessionSurfaceSelector(sessionId: string): string {
  // Session ids are UUIDs; the escape only keeps a malformed one from
  // breaking out of the attribute value.
  return `[${SESSION_SURFACE_ATTRIBUTE}="${sessionId.replace(/["\\]/g, '\\$&')}"]`;
}

function observeBody(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/**
 * Leaves a copy of `pane` where it stands and dissolves it once `sessionId`'s
 * first surface has mounted. Call while `pane` is still attached.
 */
export function leaveSessionOpenGhost(
  pane: HTMLElement,
  sessionId: string,
  canvases: ReadonlyArray<HTMLCanvasElement | null> = [],
): void {
  const box = pane.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;

  const ghost = document.createElement('div');
  ghost.setAttribute(SESSION_OPEN_GHOST_ATTRIBUTE, '');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  Object.assign(ghost.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
  // Ids stay: a gradient's `url(#id)` in the copy must still resolve, and the
  // original leaves the document in this same commit.
  const copy = pane.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('canvas').forEach((canvas, index) => {
    const pixels = canvases[index];
    if (pixels) canvas.getContext('2d')?.drawImage(pixels, 0, 0);
  });
  ghost.append(copy);
  document.body.append(ghost);

  // The page left for somewhere else (another click won the race, or the
  // push never landed): drop the copy before it is ever painted. A microtask
  // runs after this commit — the router writes the URL in it — and before the
  // browser paints.
  queueMicrotask(() => {
    if (!isSessionPath(location.pathname, sessionId)) ghost.remove();
  });

  const remove = () => ghost.remove();
  void waitForSurface(
    () => document.querySelector(sessionSurfaceSelector(sessionId)) !== null,
    SURFACE_WAIT_MS,
    observeBody,
  ).then(() => {
    // The next frame, so the surface paints once under the copy and the
    // opacity change is a transition, not the copy's first style.
    requestAnimationFrame(() => {
      ghost.setAttribute('data-leaving', '');
      // `transitionend` bubbles: only the copy's own fade may end it.
      ghost.addEventListener('transitionend', (event) => {
        if (event.target === ghost) remove();
      });
      setTimeout(remove, FADE_FALLBACK_MS);
    });
  });
}

/**
 * Makes `ref`'s element the page a composer hand-off dissolves out of.
 *
 * A layout-effect cleanup, because React runs it in the commit that removes
 * the page, before the page's DOM is detached and before the next route's DOM
 * is inserted: the copy lands in the same paint as the removal. The element is
 * read at mount — the page's root, the same node for its whole life.
 */
export function useSessionOpenSource(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const pane = ref.current;
    source = pane;
    return () => {
      if (source === pane) source = null;
      const opening = takeSessionOpening();
      if (pane && opening) leaveSessionOpenGhost(pane, opening.sessionId, opening.canvases);
    };
  }, [ref]);
}

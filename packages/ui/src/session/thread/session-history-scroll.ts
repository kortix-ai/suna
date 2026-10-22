/**
 * History-prepend scroll restoration.
 *
 * A prior version stored the anchor's VIEWPORT-relative top
 * (`getBoundingClientRect().top`) and restored it by forcing the viewport
 * back to that exact offset. That is correct only if the reader never
 * touches the scroll position between capture and restore — but the whole
 * point of the older-history sentinel is that it fires 400px before the top
 * *while the reader is actively scrolling*, during the `await loadOlder()`
 * network round trip. Any scrolling the reader did in that window got
 * silently erased by the viewport-absolute restore (teleport), and could
 * double up with the browser's own native `overflow-anchor` compensation.
 *
 * Fix: measure and restore in CONTENT space, not viewport space. Content-space
 * top (`rect.top - containerRect.top + container.scrollTop`) is invariant
 * under the reader's own scrolling — scrolling changes `rect.top` and
 * `scrollTop` by equal and opposite amounts, so they cancel — and changes
 * only by the height actually inserted above the anchor. Restoring by
 * re-adding that delta (`scrollTop += newContentTop - capturedContentTop`)
 * therefore compensates for the prepend alone: zero inserted height means
 * zero adjustment, and whatever the reader did with the scrollbar in between
 * is left untouched.
 *
 * WHEN to correct is the other half. A one-shot restore one animation frame
 * after `await loadOlder()` assumed the page had rendered by then. During a
 * live reply it has not: the transcript is paced (`usePacedStoreValue`, 50ms),
 * the stream keeps the pacer's window open, so the older page is delivered on
 * the trailing edge — after the restore measured a zero delta. The page then
 * rendered above the reader uncorrected: the view jumped by its height. The
 * "Loading older messages" row moves the reader too: it mounts above every
 * turn after the capture, and comes down 600ms after the page lands.
 *
 * So the anchor is HELD (`holdTurnScrollAnchor`) from the capture until the
 * caller releases it: every layout pass that changes the transcript's height
 * re-applies the correction in a ResizeObserver callback, which the browser
 * runs after layout and before paint. No frame is painted with the jump,
 * whenever the content lands.
 */

export interface TurnScrollAnchor {
  element: HTMLElement;
  /** The anchor's position in content space at capture time. */
  contentTop: number;
}

function contentSpaceTop(container: HTMLElement, element: HTMLElement): number {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return elementRect.top - containerRect.top + container.scrollTop;
}

export function captureTurnScrollAnchor(container: HTMLElement): TurnScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const turns = container.querySelectorAll<HTMLElement>('[data-turn-id]');
  const element =
    Array.from(turns).find((turn) => turn.getBoundingClientRect().bottom >= containerTop) ??
    turns.item(turns.length - 1);
  if (!element) return null;
  return {
    element,
    contentTop: contentSpaceTop(container, element),
  };
}

/**
 * Keep `anchor` where the reader sees it until the returned `release` runs.
 *
 * Every resize of `content` re-measures the anchor in content space and moves
 * `scrollTop` by exactly the height that appeared or disappeared above it; a
 * change inside or below the anchor measures zero and writes nothing. `release`
 * applies the last change first — call it in the commit that makes that change
 * (a layout effect runs before the ResizeObserver would) — then stops. It is
 * idempotent. An anchor that left the DOM is never written.
 */
export function holdTurnScrollAnchor(
  container: HTMLElement,
  content: HTMLElement,
  anchor: TurnScrollAnchor | null,
): () => void {
  if (!anchor) return () => {};
  let heldTop: number | null = anchor.contentTop;
  const apply = () => {
    if (heldTop === null || !anchor.element.isConnected || !container.contains(anchor.element)) return;
    const top = contentSpaceTop(container, anchor.element);
    const inserted = top - heldTop;
    heldTop = top;
    if (inserted !== 0) container.scrollTop += inserted;
  };
  const observer = new ResizeObserver(apply);
  observer.observe(content);
  return () => {
    if (heldTop === null) return;
    apply();
    heldTop = null;
    observer.disconnect();
  };
}

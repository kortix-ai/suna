/**
 * History-prepend scroll restoration — the FLAT list's path.
 *
 * The VIRTUAL list (`timeline/session-timeline-list.tsx`, the default in
 * `SessionChat`) does not use this: its virtualizer anchors a prepend inside
 * the commit that adds the turns (`anchorTo: 'end'` — the item at the viewport
 * top keeps its offset, resolved before paint), and a turn above the viewport
 * that is measured later moves the viewport by its own delta
 * (`shouldAdjustForResize`). `SessionChat.handleLoadOlder` calls the two
 * functions below only while `timelineApiRef` is null.
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

export function restoreTurnScrollAnchor(
  container: HTMLElement,
  anchor: TurnScrollAnchor | null,
): boolean {
  if (!anchor?.element.isConnected || !container.contains(anchor.element)) return false;
  const newContentTop = contentSpaceTop(container, anchor.element);
  container.scrollTop += newContentTop - anchor.contentTop;
  return true;
}

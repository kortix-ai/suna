import type { SyntheticEvent } from 'react';

/**
 * Wrap a row or card click handler so it ignores clicks that only reach it
 * through React's tree.
 *
 * A dropdown menu renders its items in a portal, but React bubbles their
 * events through the component tree, not the DOM. Without this, choosing
 * Remove in a file card's menu also fires the card's own click, which opens
 * the preview above the delete confirmation it just asked for (and choosing
 * Remove on a folder navigates into the folder being deleted).
 */
export function ownClicks(handler: (() => void) | undefined) {
  if (!handler) return undefined;
  return (event: SyntheticEvent) => {
    const host = event.currentTarget as { contains?: (node: unknown) => boolean } | null;
    if (typeof host?.contains === 'function' && !host.contains(event.target)) return;
    handler();
  };
}

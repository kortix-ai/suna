'use client';

/**
 * Open the command palette from OUTSIDE it (the sidebar's search button).
 *
 * The palette owns `open` as local state and is lazily mounted by the shell,
 * so there is no store to write and no ref to reach for. It already listens
 * for `kortix:open-file-search` to be summoned onto its Files page; this is
 * the same door onto its root page.
 *
 * The request is BUFFERED, not just dispatched. The search button paints as
 * soon as the sidebar does, which is before the palette's lazy chunk has
 * finished loading — a plain event fired in that window reaches no listener
 * and the click does nothing. (⌘K has the same gap and gets away with it:
 * nobody reaches for a shortcut in the first paint, and a dead keystroke
 * reads as "I mistyped", while a dead button reads as broken.) The flag is
 * consumed on mount, so an early click opens the palette the moment it exists.
 */

export const OPEN_COMMAND_PALETTE_EVENT = 'kortix:open-command-palette';

let requested = false;

export function openCommandPalette(): void {
  if (typeof window === 'undefined') return;
  requested = true;
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}

/**
 * Read-and-clear. Returns true if an open was requested; clearing is what
 * keeps a later remount of the palette from re-opening itself off a stale
 * request.
 */
export function consumePendingCommandPalette(): boolean {
  const was = requested;
  requested = false;
  return was;
}

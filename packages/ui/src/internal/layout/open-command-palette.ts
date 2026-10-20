'use client';

/**
 * Open the command palette from OUTSIDE it (the sidebar's search button).
 *
 * The palette owns `open` as local state and is lazily mounted by the shell,
 * so there is no store to write and no ref to reach for. It already listens
 * for `kortix:open-file-search` to be summoned onto its Files page; this is
 * the same door onto its root page.
 *
 * The request is buffered while the palette chunk loads. The eager Suspense
 * fallback reads it without consuming it; the loaded palette consumes it.
 */

export const OPEN_COMMAND_PALETTE_EVENT = 'kortix:open-command-palette';

let requested = false;

export function openCommandPalette(): void {
  if (typeof window === 'undefined') return;
  requested = true;
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}

/** Read without consuming, so the loading dialog can hand off to the palette. */
export function hasPendingCommandPalette(): boolean {
  return requested;
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

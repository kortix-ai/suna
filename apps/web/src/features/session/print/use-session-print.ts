'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadEntireHistory } from './load-entire-history';
import { clearPrintChain, markPrintChain } from './print-chain';

/**
 * Cmd+P prints the WHOLE conversation, not the part that happens to be on
 * screen.
 *
 * Two things have to happen before the browser's print dialog opens, and both
 * of them are invisible to the user if we get them wrong:
 *
 *  - the transcript is PAGED. `loadOlder()` prepends the previous page; without
 *    draining it first the PDF is the tail of a conversation and nothing
 *    before, which looks complete and is not.
 *  - the shell CLIPS. The transcript's ancestors are `overflow-hidden` flex
 *    boxes, so the print is one viewport tall until `print-chain.ts` dissolves
 *    them.
 *
 * Cmd+P is intercepted rather than left to the browser because neither of those
 * can be expressed in CSS. The native shortcut still does the thing the user
 * expects — it just waits for the document to be complete first.
 */

export interface UseSessionPrintOptions {
  /** The transcript scroller. Everything above it gets dissolved for print. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Another page of history exists before the oldest rendered message. */
  hasOlder: boolean;
  /** A history pull is already in flight. */
  isLoadingOlder: boolean;
  /** Pull one more page. */
  loadOlder: () => Promise<unknown> | unknown;
  /** Off for a surface with no transcript (the boot shell, a sub-session). */
  enabled?: boolean;
}

export interface UseSessionPrintResult {
  /** True while history is draining — the window between Cmd+P and the dialog. */
  isPreparing: boolean;
  /** Same flow as Cmd+P, for a menu item or button. */
  printSession: () => Promise<void>;
}

/**
 * How long the dissolved layout may stand if `afterprint` never arrives.
 *
 * The chain has to survive the whole dialog — a user comparing pages in the
 * preview can sit there for minutes — so this is a leak guard, not a deadline.
 * Whatever happens, the app is never left rendering as `display: contents`.
 */
export const PRINT_CLEANUP_FALLBACK_MS = 10 * 60_000;

/** One frame, so React can commit a prepended page before we re-read `hasOlder`. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 16);
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

export function useSessionPrint(options: UseSessionPrintOptions): UseSessionPrintResult {
  const { scrollRef, hasOlder, isLoadingOlder, loadOlder, enabled = true } = options;
  const [isPreparing, setIsPreparing] = useState(false);

  // The drain loop runs inside one async call, so it cannot see React state
  // change. Refs are what it reads instead — see `loadEntireHistory`.
  //
  // Written in an effect, never during render: the same rule the rest of the
  // session surfaces follow (`queueRowsRef` in `session-chat.tsx`), and the one
  // `react-hooks/refs` enforces. An effect is correct here as well as legal —
  // the loop only ever reads these between frames, after a commit.
  const stateRef = useRef({ hasOlder, isLoadingOlder });
  const loadOlderRef = useRef(loadOlder);
  useEffect(() => {
    stateRef.current = { hasOlder, isLoadingOlder };
    loadOlderRef.current = loadOlder;
  }, [hasOlder, isLoadingOlder, loadOlder]);

  // Re-entrancy guard. Holding Cmd+P repeats the keydown, and a second drain
  // racing the first pulls the same cursor twice.
  const printingRef = useRef(false);

  const printSession = useCallback(async () => {
    if (printingRef.current) return;
    printingRef.current = true;
    setIsPreparing(true);

    let marked: HTMLElement[] = [];
    try {
      await loadEntireHistory({
        readState: () => stateRef.current,
        loadOlder: () => loadOlderRef.current(),
        settle: nextFrame,
      });
      // The last prepended page has to be laid out before the chain is marked:
      // `display: contents` on a box mid-commit is a reflow the print snapshot
      // can catch halfway.
      await nextFrame();
      marked = markPrintChain(scrollRef.current, document.body);
      // And one more, so the dissolved layout is painted before the snapshot.
      await nextFrame();
      setIsPreparing(false);

      // CLEANUP IS ARMED BEFORE THE PRINT, AND NEVER RUNS RIGHT AFTER IT.
      //
      // `window.print()` blocks until the dialog closes in Chrome but returns
      // immediately in Safari, so "unmark on the next line" unmarks the chain
      // while Safari is still composing the page — the shell snaps back and the
      // user gets the same clipped viewport this whole file exists to prevent.
      // `afterprint` is the one signal both engines agree on, with a timer as
      // the backstop for a dialog that is dismissed without firing it.
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(fallback);
        window.removeEventListener('afterprint', cleanup);
        clearPrintChain(marked);
        printingRef.current = false;
      };
      const fallback = setTimeout(cleanup, PRINT_CLEANUP_FALLBACK_MS);
      window.addEventListener('afterprint', cleanup);
      window.print();
    } catch {
      clearPrintChain(marked);
      printingRef.current = false;
      setIsPreparing(false);
    }
  }, [scrollRef]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'p' && event.key !== 'P') return;
      // Cmd on macOS, Ctrl elsewhere — and never both, so Ctrl+Cmd+P and the
      // Shift variants fall through to whatever else owns them.
      const chord = event.metaKey !== event.ctrlKey;
      if (!chord || event.altKey || event.shiftKey) return;
      event.preventDefault();
      void printSession();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, printSession]);

  return { isPreparing, printSession };
}

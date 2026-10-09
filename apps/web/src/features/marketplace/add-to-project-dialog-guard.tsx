'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Rides out the known client-side crash class on the marketplace item page:
 * the page is the one signed-in surface where third-party scripts load (GTM
 * tags — consent overlays, ad iframes — see `lib/analytics/gtm.ts`), and an
 * external DOM writer that mutates the document between React's commits makes
 * React's reconciler throw the canonical DOM-mutation DOMException
 * (`insertBefore`/`removeChild` NotFoundError — the class classified as
 * browser noise in `lib/browser-noise/rules/react.ts`). When it races the
 * Add-to-project dialog's first mount, the nearest error boundary was the
 * root locale one, so one transient throw replaced the whole page with
 * "Something went wrong" (KRTX-1950, observed 1/2 on dev, never on the
 * second attempt).
 *
 * The guard scopes the blast radius to the dialog and survives the race:
 * the first crash while the dialog opens remounts it once (the observed-good
 * second attempt); if the retry crashes too, the caller closes the dialog and
 * the page stays intact. The state machine keeps every transition one
 * purpose, because a keyed boundary whose subtree throws mid-flush can drop
 * sibling updates: `onRetry` only remounts, `onGiveUp` only closes, and a
 * fresh open takes a fresh boundary (`mount` bumps there), so the one-retry
 * budget is always per open and a crashed boundary is never reused.
 */
export interface DialogCrashGuard {
  /** Key for the boundary that owns the dialog — bump to remount it fresh. */
  mount: number;
  /** Whether the current open has already spent its one retry. */
  retried: boolean;
  /** Wrap the dialog's own onOpenChange: a fresh open takes a fresh boundary. */
  handleOpenChange: (open: boolean) => void;
  /** First crash: remount the dialog once. */
  onRetry: () => void;
  /** Retry crashed too: hand the decision back to the caller (close the dialog). */
  onGiveUp: () => void;
}

export function useDialogCrashGuard({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}): DialogCrashGuard {
  const [mount, setMount] = useState(0);
  const [retried, setRetried] = useState(false);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setRetried(false);
        setMount((m) => m + 1);
      }
      onOpenChange(open);
    },
    [onOpenChange],
  );

  const onRetry = useCallback(() => {
    setRetried(true);
    setMount((m) => m + 1);
  }, []);

  const onGiveUp = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return { mount, retried, handleOpenChange, onRetry, onGiveUp };
}

/**
 * Rendered as the crash boundary's fallback. Effects only — the boundary
 * render itself must stay side-effect free — and the actions arrive through a
 * ref so a re-render while the fallback is up can never re-run the decision.
 * The thrown error is logged either way: the original dogfood report of this
 * crash carried only "[Kortix Home Error] DOMException" and no stack, which
 * is what made the diagnosis guesswork.
 */
export function DialogCrashRecovery({
  error,
  retried,
  onRetry,
  onGiveUp,
}: {
  error: Error;
  retried: boolean;
  onRetry: () => void;
  onGiveUp: () => void;
}) {
  useEffect(() => {
    console.error('[marketplace] add-to-project dialog mount crashed', error);
    if (retried) onGiveUp();
    else onRetry();
  }, [error, retried, onRetry, onGiveUp]);

  return null;
}

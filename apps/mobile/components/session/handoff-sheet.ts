/**
 * The "Continue closes the sheet first, then the hand-off runs" pattern —
 * Paper board 08's close-then-open rule ("never two overlays"), factored out
 * of `ConnectProviderSheet` so `ConnectorAuthSheet` (COR-158's connector
 * hand-off) reuses it instead of duplicating the pendingRef dance.
 *
 * `run` fires from the sheet's own `onDismiss`, once, and ONLY when the
 * dismiss followed a Continue tap — a swipe-to-close or "Not now" never fires
 * it. The sheet component itself stays mounted the whole time (a permanent
 * sibling of the composer), so `run`'s closures over its own props are
 * unaffected by the *modal* dismissing — only `pendingRef` distinguishes the
 * two kinds of dismiss.
 *
 * `onCancel` (optional) fires from the same `onDismiss` when the dismiss did
 * NOT follow Continue — "Not now", a swipe, the backdrop — so a caller that
 * closed its own sheet to show this one can bring it back.
 */
import * as React from 'react';

import type { SheetRef } from '@/components/kortix/sheet';
import { haptics } from '@/lib/haptics';

export function useHandoffDismiss(run: () => void | Promise<void>, onCancel?: () => void) {
  // Set only by Continue, read (and cleared) once by `handleDismiss`.
  const pendingRef = React.useRef(false);

  const requestContinue = React.useCallback(
    (sheetRef: React.RefObject<SheetRef | null>) => {
      haptics.tap();
      // Close first — the hand-off runs only once this sheet is fully gone
      // (`handleDismiss`), so the two are never on screen together.
      pendingRef.current = true;
      sheetRef.current?.close();
    },
    [],
  );

  const handleDismiss = React.useCallback(async () => {
    if (!pendingRef.current) {
      onCancel?.();
      return;
    }
    pendingRef.current = false;
    await run();
  }, [run, onCancel]);

  return { requestContinue, handleDismiss };
}

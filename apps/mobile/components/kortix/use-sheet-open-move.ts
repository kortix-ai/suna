import * as React from 'react';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { sheetOpenMove } from '@/lib/ui/sheet-open';

/**
 * The present/dismiss glue for a `KortixBottomSheetModal` driven by an `open`
 * boolean, through `sheetOpenMove` (`lib/ui/sheet-open.ts`): a closed sheet
 * that was never presented is never dismissed — gorhom's modal refuses to
 * render after a dismiss that came before its first present (the device bug:
 * the sheet never appeared). Presenting waits one frame, so a sheet mounted
 * by the same render that opens it is on screen before `present` runs.
 *
 * Call `markDismissed()` from the sheet's `onDismiss`.
 *
 * React-only (the sheet ref is a plain object), so the switcher's
 * characterization test loads this module real, without the sheet module's
 * native graph — the same split `use-close-then.ts` makes.
 */
export function useSheetOpenMove(ref: React.RefObject<BottomSheetModal | null>, open: boolean) {
  const presentedRef = React.useRef(false);
  React.useEffect(() => {
    const move = sheetOpenMove(open, presentedRef.current);
    if (move === 'present') {
      presentedRef.current = true;
      const frame = requestAnimationFrame(() => ref.current?.present());
      return () => cancelAnimationFrame(frame);
    }
    if (move === 'dismiss') {
      presentedRef.current = false;
      ref.current?.dismiss();
    }
  }, [open, ref]);
  return {
    /** True while the sheet is on screen: set on present, cleared by markDismissed. */
    isPresented: () => presentedRef.current,
    /** Present and mark presented (a re-present must count as presented too). */
    present: React.useCallback(() => {
      presentedRef.current = true;
      ref.current?.present();
    }, [ref]),
    markDismissed: React.useCallback(() => {
      presentedRef.current = false;
    }, []),
  };
}

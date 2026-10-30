/**
 * Whether the sheet a subtree renders in has finished its open animation
 * (KRTX-2929).
 *
 * gorhom unmounts a modal's content on dismiss, so every open mounts the
 * whole body again. A long list (every model of every provider, every project
 * of an account) mounted in the same frames as the open animation costs the
 * JS thread and, on Fabric, the UI thread that runs the animation: the sheet
 * starts late and drops frames. `KortixBottomSheetModal` provides `false`
 * from `present` until gorhom reports the first resting index, then `true`.
 * A body renders the rows that fill the screen first and the rest once the
 * sheet is at rest (`useSheetRowLimit`). Use it only in a fixed-detent sheet
 * (`enableDynamicSizing={false}`) or for rows past what a content-sized sheet
 * shows: in a content-sized sheet the late rows would grow the sheet after it
 * opened.
 *
 * Outside a sheet the value is `true`: nothing is deferred.
 *
 * React-only, so a bun test loads it real without the sheet's native graph
 * (the split `use-sheet-open-move.ts` makes).
 */
import * as React from 'react';

export const SheetSettledContext = React.createContext(true);

/** Rows mounted while the sheet opens: more than a full-height sheet shows (~14 rows of 52pt). */
export const SHEET_OPENING_ROWS = 16;

/** How many of `total` rows to render now: all at rest, `SHEET_OPENING_ROWS` while the sheet opens. */
export function useSheetRowLimit(total: number): number {
  const settled = React.useContext(SheetSettledContext);
  return settled ? total : Math.min(total, SHEET_OPENING_ROWS);
}

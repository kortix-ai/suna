/**
 * Every sheet can reach full screen (Jay, 2026-09-22): a sheet opens at the
 * size its call site asks for, and a drag up takes it to 100%. The rule lives
 * here so `KortixBottomSheetModal` applies it to every sheet at once.
 *
 * gorhom sorts detents, so appending `'100%'` never shifts the indices of the
 * detents a call site gave (the ones it presents at). With dynamic sizing the
 * content-height detent still merges in — gorhom adds it beside the list and
 * deduplicates it — so a content-sized sheet opens at its content and expands.
 */

export const FULL_DETENT = '100%';

/** `snapPoints` as gorhom accepts them; a Reanimated shared value passes through. */
export type SheetDetents = ReadonlyArray<string | number> | { value: unknown };

/** The detents with `'100%'` at the end when none is there yet. */
export function withFullDetent(detents: SheetDetents | undefined): SheetDetents {
  if (detents === undefined) return [FULL_DETENT];
  if (!Array.isArray(detents)) return detents;
  const list = detents as ReadonlyArray<string | number>;
  return list.some((detent) => detent === FULL_DETENT) ? list : [...list, FULL_DETENT];
}

/** A stable key for a list of detents, so a fresh inline array does not remount the sheet. */
export function detentsKey(detents: SheetDetents | undefined): string | SheetDetents | undefined {
  return Array.isArray(detents) ? (detents as ReadonlyArray<string | number>).join('|') : detents;
}

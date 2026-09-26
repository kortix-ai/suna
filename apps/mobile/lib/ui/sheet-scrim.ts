/**
 * sheet-scrim — the colour of the overlay behind every bottom sheet
 * (`SheetBackdrop`, `components/kortix/sheet.tsx`).
 *
 * Light mode keeps gorhom's black scrim. Dark mode fades toward the page
 * background (`--background`, hsl(0 0% 4.3%) ≈ rgb 11) instead (Jay,
 * 2026-09-27): black at 50% sank the dark page to rgb 5, a near-black level
 * that OLED panels show with a visible red cast. Toward the page colour the
 * page stays at its own neutral level, bright content still dims by the same
 * amount (white → rgb 133 at 50%), and the sheet surface (`--popover`,
 * hsl(0 0% 7.8%)) stays above the dimmed page. The scrim's opacity is
 * unchanged, so every call site's lighter overlay keeps its strength.
 *
 * Pure data: unit-tested under `bun test`. The caller passes the page
 * background (`THEME.dark.background`, pinned to `global.css` by
 * `lib/utils/theme.test.ts`): importing `THEME` here would load react-native.
 */

/** The backdrop colour, or undefined for gorhom's own black. */
export function sheetScrimColor(isDark: boolean, darkPageBackground: string): string | undefined {
  return isDark ? darkPageBackground : undefined;
}

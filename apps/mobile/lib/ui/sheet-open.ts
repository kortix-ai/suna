/**
 * sheet-open — what a sheet driven by an `open` prop does when `open` changes.
 *
 * A gorhom `BottomSheetModal` (5.2.x) must never get `dismiss()` before its
 * first `present()`. `handleDismiss` on a never-presented modal sets its
 * status to DISMISSING and has no sheet to close, so the status stays there.
 * The next `present()` mounts the portal, but `handlePortalRender` returns
 * early while the status is DISMISSING: the sheet never renders. The parent's
 * `open` stays true, so later taps change nothing either.
 *
 * A sheet that is mounted closed (the project switcher) hits this on its
 * first open. The same happens after the sheet
 * dismissed itself (pan down, the X, a pick): gorhom resets the status to
 * INITIAL, and the parent then flips `open` to false. So a sheet tracks
 * whether it is on screen (set on present, cleared in `onDismiss`) and asks
 * this function what to do.
 *
 * Pure: no React or React Native imports (bun test).
 */
export function sheetOpenMove(open: boolean, presented: boolean): 'present' | 'dismiss' | 'none' {
  if (open) return 'present';
  return presented ? 'dismiss' : 'none';
}

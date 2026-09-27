/**
 * Named `@rn-primitives/portal` hosts.
 *
 * `OVERLAY_PORTAL_HOST` is mounted in `app/_layout.tsx` AFTER
 * `BottomSheetModalProvider`, so what portals into it draws above an open
 * bottom sheet. The default host sits inside that provider, under gorhom's own
 * portal host: a `Select` or `DropdownMenu` opened from inside a sheet would
 * render behind the sheet on Android. (On iOS RNR wraps the content in a
 * `FullWindowOverlay`, which is above everything either way.)
 *
 * Pass it as `portalHost` to `SelectContent` / `DropdownMenuContent` /
 * `PopoverContent` whenever the trigger lives inside a bottom sheet.
 */
export const OVERLAY_PORTAL_HOST = 'overlay';

# Desktop native titlebar alignment

## Problem

The Settings and account hub overlays reserve a blank macOS titlebar strip above their first rows. Their actions and breadcrumbs sit below the native traffic lights. When the account sidebar collapses, the breadcrumb starts beneath the lights. The native lights also need visual calibration against project and session headers.

## Contract

- Use AppKit's native close, minimize, and zoom controls. Do not draw replacements.
- Put the first Settings and account hub row in the same physical 40px band as the lights. Remove the overlay-only spacer.
- In an expanded 300px sidebar, keep a non-interactive safe area over the lights. Align Back to app, Search, and Hide Sidebar on the band centerline, packed toward the sidebar's right edge. Settings has only Back to app in that cluster.
- Put the Settings and account breadcrumb in the adjacent content column on the same centerline. Keep a single vertical border at the sidebar edge and one horizontal border below the breadcrumb. Content begins directly below the row; no blank strip remains.
- When the account sidebar collapses, show its opener after the native-light safe area, then the breadcrumb. The breadcrumb may truncate but must not overlap the lights or opener.
- Keep the existing project and session UI rows in place. Calibrate the native-light position against their measured centerline. A macOS-only native offset is allowed; changing all shared web headers to disguise an offset is not.
- At native fullscreen, the lights are hidden and their safe area disappears. At browser zoom, native-light clearance remains in window pixels. On Windows and Linux, the native frame owns its controls, so no macOS gutter appears.
- At 720 × 480, both expanded and collapsed layouts remain usable. All titlebar buttons remain clickable, and the empty parts of the row remain draggable.

## Implementation boundaries

- `apps/desktop-electron/src/window-chrome.js` owns native control position and physical band metrics.
- `apps/web/src/app/globals.css` mirrors those metrics for zoom-safe macOS clearance and explicit titlebar classes only.
- `apps/web/src/features/workspace/settings/settings-panel.tsx` owns the personal Settings overlay.
- `apps/web/src/features/accounts/hub/account-settings-sidebar.tsx`, `account-settings-shell.tsx`, and `account-hub-panel.tsx` own the account hub overlay.
- No generic sidebar, ARIA-role, or page-content selector receives titlebar positioning.

## Verification

Unit/source tests pin the native-control contract, spacer removal, row centerline, and collapsed clearance. The desktop Playwright journey measures rendered positions at default zoom, altered zoom, minimum size, sidebar collapse, and fullscreen. Visual inspection compares real Electron against the supplied references. Browser checks confirm the shared web layout still works without native controls.

The supplied screenshots are diagnostic only. Do not copy account names, email addresses, or other personal data into tests, commits, PR text, or documentation.

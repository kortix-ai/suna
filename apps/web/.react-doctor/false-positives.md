# react-doctor: documented false positives and intentional keeps

Each entry records an error-severity diagnostic that remains in the report
deliberately. A suppression is valid only while every predicate below still
holds. Re-verify before trusting an entry. Last triage: 2026-10-22,
react-doctor 0.9.18, `--scope full`, projects `apps/web` and `packages/ui`.

## artifact-secret-leak (18), `apps/web/public/i18n/*.json`

- The files are gitignored (`apps/web/.gitignore:69`) local leftovers from
  14 Oct and 20 Oct. No script in the tree writes `public/i18n/` now.
- The matched value was the PEM-header placeholder of the GitHub App private-key
  field (`text8bcac7908eb9`). The source catalogs in `translations/` now carry
  "Paste the contents of the .pem file". Delete the local `public/i18n/` folder
  to clear the finding.

## no-layout-property-animation: intrinsic-size animations

All are `height: 0↔auto` or width morphs whose purpose is sibling reflow.
Transforms cannot reflow siblings, and the rule's recipe endorses bounded
one-shot intrinsic-size animations.

- `src/features/billing/auto-topup-card.tsx:272-274`: `overflow-hidden`
  accordion, one-shot on toggle.
- `src/features/drives/drive-conflicts-bar.tsx:98,119-121`: the pill widens to
  the panel width and the panel expands its height. The bar must resize, not
  scale its text.
- `packages/ui/src/customize/sections/view/permission-editor.tsx:174-176`:
  the same accordion pattern (Rules reveal).
- `packages/ui/src/session/panel/session-action-panel-column.tsx:158,243`:
  `marginLeft` and `width: 0↔PANEL_WIDTH` reflow the neighboring chat column.
- `packages/ui/src/primitives/sliding-tab-indicator.tsx:188-189`: the pill width
  morphs across tabs of different width. A scale distorts the caller-supplied
  radius.
- `packages/ui/src/primitives/switch.tsx:173-174`: a 16px thumb morph on a
  rounded-full capsule. A scale distorts the capsule radius.

## effect-needs-cleanup: cleanup exists but the detector does not see it

- `src/app/[locale]/(auth)/auth/github-connect/page.tsx:28`: `armClose` stores
  the id in `closeTimer`. Both returned cleanups clear it.
- `src/app/[locale]/(auth)/auth/github-popup/page.tsx:26`: every timer id is a
  mutable local. The returned cleanup clears each one and sets `cancelled`.
- `src/app/[locale]/(system)/debug/session-fixture/bench/bench.tsx:272`: the
  `PerformanceObserver`s go into `observers` and are disconnected at the end of
  the run (line ~316).
- `src/app/[locale]/a1o/die-scene.tsx:540`: the listener sits on the renderer's
  own canvas, which `<Canvas>` destroys on unmount.
- `src/components/turn-attention-badge.tsx:193`: the cleanup sets `cancelled`
  and calls `observer?.disconnect()`.
- `src/components/ui/animated-bg.tsx:187`: `on('change')` returns the
  unsubscribe function, and the effect returns it.
- `packages/ui/src/browser/browser-panel.tsx:340` and
  `packages/ui/src/session/media/sandbox-url-detector.tsx:121`: the effect
  returns the `clearLoadTimeout` helper.
- `packages/ui/src/session/composer/composer.tsx:1095`: the cleanup calls
  `stopObserving()`, which disconnects both observers.
- `packages/ui/src/session/panel/easy/app-preview.tsx:196`: the cleanup sets
  `alive = false`, aborts the controller, and clears `deadline` and `timer`.
- `packages/ui/src/session/thread/session-chat.tsx:3299`: a handler-armed fade
  timer owned by `escFadeTimerRef`. A same-effect cleanup would cancel the fade
  on every `escCount` change.
- `packages/ui/src/session/thread/session-chat.tsx:3517`: a 50 ms
  `scrollToBottom`. `goToEnd` returns early once `scrollRef.current` is null.

## no-hydration-branch-on-browser-global

- `src/features/accounts/hub/account-hub-content.tsx:368,819`: `returnUrl` and
  `returnPath` are read only in click handlers (checkout, GitHub install). The
  hub is a client-opened modal, so it never renders on the server.
- `packages/ui/src/files/viewer/file-preview-modal.tsx:349`: guards
  `createPortal(node, document.body)`. A portal adds no DOM at this tree
  position.
- `packages/ui/src/internal/notifications/notification-bell.tsx:328,355`:
  `offerTurnOn` feeds a prop inside `PopoverContent`. That content mounts only
  while `open`, which is `false` initially.
- `packages/ui/src/markdown/genui/components/map-canvas.tsx:170`: the value
  reaches the DOM only through `Map` children. `Map` renders them only after an
  effect sets `mapInstance`.

## no-unguarded-browser-global-in-render-or-hook-init

- `src/features/marketing/download/download-modal.tsx:51`: `navigator` is read
  only while `open`, and the modal opens from a click.
- `src/app/[locale]/(system)/debug/session-fixture/bench/bench.tsx:223` and
  `src/app/[locale]/(system)/debug/stream/harness.tsx:168`: loaded with
  `dynamic(..., { ssr: false })` from their `page.tsx`.
- `src/app/[locale]/(system)/debug/modal-stack/page.tsx:216`: the portal
  renders only when the `useSyncExternalStore` snapshot is not null. The server
  snapshot (`serverLayers`) is null.
- `packages/ui/src/primitives/map.tsx:224,280`: `MapMarker` and `MarkerPopup`
  render only under the `mapInstance` gate.
- `packages/ui/src/workspace/sidebar/session-brief-hover-card.tsx:333`: mounted
  only under `canShowSessionHoverCard` (`useMediaQuery`), which is `false` on
  the server.

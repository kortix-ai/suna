# react-doctor: documented false positives and intentional keeps

Each entry records a diagnostic that remains in the report deliberately. A
suppression is valid only while every predicate below still holds — re-verify
before trusting an entry. Triage date: 2026-08-17, branch `react-doctor`.

## no-layout-property-animation (20) — intentional intrinsic-size animations

All are `height: 0↔auto` / `width: 0↔<px>` enter-collapse animations whose
purpose is sibling reflow. Transforms cannot reflow siblings; the rule's own
recipe endorses keeping bounded one-shot intrinsic-size animations.

- `src/app/(public)/share/[shareId]/_components/ShareViewer.tsx:349-351,370-372` —
  28px thumb button enter/exit; row must compact when it leaves.
- `src/components/ui/sliding-tab-indicator.tsx:102-103` — pill width morphs
  across different-width tabs (the component's contract); caller-supplied
  `indicatorClassName` owns border-radius, so layout-projection would distort it.
- `src/components/ui/switch.tsx:172-173` — 16px thumb ±2/4px hover/press morph
  on a rounded-full capsule; scale distorts the capsule radius and `x` is a
  drag-driven motionValue.
- `src/features/accounts/settings/general-tab.tsx:483-485` — one-shot
  `height: 0↔auto` list reveal in a modal.
- `src/features/billing/auto-topup-card.tsx:228-230` — `overflow-hidden`
  accordion, one-shot on toggle.
- `src/features/workspace/customize/sections/view/permission-editor.tsx:169-171` —
  same accordion pattern (Rules reveal).
- `src/features/session/session-action-panel-column.tsx:217` —
  `width: 0↔PANEL_WIDTH` exists to reflow the neighboring chat column; inner
  content is fixed-width so no per-frame text reflow.

## effect-needs-cleanup (12) — cleanup exists but is detector-invisible

- `src/app/(app)/projects/start/page.tsx:152` — retry timer stored in
  `retryTimer` ref, cleared in a dedicated unmount-only effect (same-effect
  cleanup would cancel the in-flight retry chain on query-data changes).
- `src/app/(auth)/auth/github-popup/page.tsx:26` — session-settle delay id
  captured and cleared in the effect's existing cleanup.
- `src/app/(public)/voice/[token]/page.tsx:347` — mutable `timer` reassigned in
  `poll`, cleared in returned cleanup with `cancelled` guard (recipe pattern D).
- `src/app/a1o/die-scene.tsx:575` — listener registered in R3F `onCreated`
  hand-off, target is the renderer's own canvas destroyed with `<Canvas>`.
- `src/components/setup-links/connector-intake.tsx:82` — pattern D: `schedule()`
  arms mutable `timer`, returned cleanup clears it.
- `src/components/ui/animated-bg.tsx:302` — `on('change')` returns unsubscribe;
  effect does `return unsubscribe` (recipe pattern C).
- `src/components/ui/sliding-tab-indicator.tsx:68` — cleanup at lines 81-85
  disconnects the ResizeObserver and removes both listeners; the only early
  return precedes any registration.
- `src/features/session/action-panel/browser-panel.tsx:428` and
  `src/features/session/sandbox-url-detector.tsx:117` — effect returns the
  memoized `clearLoadTimeout` helper.
- `src/features/session/action-panel/easy/app-preview.tsx:211` — cleanup sets
  `alive=false`, aborts the probe controller, clears `deadline` and poll timers.
- `src/features/session/composer/composer.tsx:575` — returned cleanup calls
  `stopObserving()` + `detachListbox()`, disconnecting both observers.
- `src/features/session/session-chat.tsx:3646` — handler-armed fade timer
  cleared by a dedicated unmount-only effect (`escFadeTimerRef`); same-effect
  cleanup would cancel the 4s fade on every `escCount` change.

## no-set-state-after-await-in-effect

- `src/features/file-renderers/sqlite-renderer.tsx` (init effect) — every
  post-await setState, including the `finally` loading reset, is guarded by
  `!cancelled && !abortController.signal.aborted`; the cleanup sets `cancelled`
  and aborts. This is the loading-flag recipe's own canonical pattern.

## no-hydration-branch-on-browser-global (2)

- `src/app/(app)/accounts/[id]/page.tsx:495` — the branch selects a
  `returnUrl` prop consumed only inside a click handler
  (`billing-tab.tsx:71-73`); it never reaches rendered output.
- `src/features/file-viewer/file-preview-modal.tsx:276` — guards
  `createPortal(node, document.body)`; portal children contribute no DOM at
  this tree position during SSR/hydration, and `isOpen` gates first.

## no-impure-state-updater (1)

- `src/features/layout/account-switcher.tsx:213` — `deferAfterClose` is a plain
  local helper (`setMenuOpen(false)` + `requestAnimationFrame`), not a state
  updater; `setCreateOpen` runs in a RAF callback.

## no-prop-callback-in-render (1)

- `src/features/workspace/shared/settings-nav-context.test.tsx:73` — test
  renders via `renderToStaticMarkup`, which never runs effects; a render-phase
  `report(nav)` is the only way to capture the context value (documented in the
  file at lines 62-66).

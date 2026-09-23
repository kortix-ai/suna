# Desktop Native Titlebar Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align native macOS traffic lights, overlay actions, and breadcrumbs without gaps or overlap.

**Architecture:** Keep AppKit controls in Electron. Place Settings and account hub first rows in the existing macOS titlebar band. Apply zoom-safe light clearance only to explicit titlebar rows. Use the same geometry test and one real Electron journey for expanded, collapsed, zoomed, fullscreen, and minimum-size states.

**Tech Stack:** Electron 39, Next.js 16, React, Tailwind CSS, Bun tests, Playwright Electron.

**Spec:** `docs/superpowers/specs/2026-09-23-desktop-native-titlebar-alignment-design.md`

## Global Constraints

- Keep native macOS controls; never draw web replacements.
- Keep one `desktop-hardening` branch and worktree. Do not merge its draft PR.
- Do not publish screenshot account identifiers or personal data.
- Preserve 720 × 480 minimum size and zoom-safe clearance in window pixels.
- Do not apply titlebar rules to generic sidebars, ARIA roles, or page content.

## Review Focus

- Expanded sidebar at 720px: Back, Search, and Hide Sidebar stay visible and outside the native-light hit area.
- Collapsed account sidebar: opener and breadcrumb do not overlap the native lights.
- Non-100% zoom: the safe area remains fixed in physical window pixels.
- Fullscreen: hidden lights leave no empty gutter.
- Browser and non-macOS shells: no macOS-only spacer or light gutter appears.

---

### Task 1: Overlay titlebar structure

**Files:**
- Modify: `apps/web/src/features/workspace/settings/settings-panel.tsx`
- Modify: `apps/web/src/features/accounts/hub/account-hub-panel.tsx`
- Modify: `apps/web/src/features/accounts/hub/account-settings-sidebar.tsx`
- Modify: `apps/web/src/features/accounts/hub/account-settings-shell.tsx`
- Test: `apps/web/src/features/workspace/settings/settings-panel.test.tsx`
- Test: `apps/web/src/features/workspace/project-layout/desktop-titlebar.test.ts`

**Interfaces:** Consume the existing `.kx-titlebar-row` and `.kx-titlebar-band-height` classes. Produce explicit first-row markers for test selection. Preserve existing close, command-palette, and sidebar-toggle callbacks.

- [ ] **Step 1: Write failing structure tests.** Assert neither overlay renders `.kx-titlebar-spacer`; assert Settings Back lives in a `.kx-titlebar-row` with a right-aligned action group; assert account sidebar actions and account breadcrumb each live in a titlebar row; assert the collapsed header exposes a state marker to gate macOS clearance.
- [ ] **Step 2: Run tests to verify failure.** With the repository-supported Node version active, run `pnpm exec bun test apps/web/src/features/workspace/settings/settings-panel.test.tsx apps/web/src/features/workspace/project-layout/desktop-titlebar.test.ts`.
- [ ] **Step 3: Remove both overlay spacer elements.** Change only the overlay shells. Make their first row own the band. Pack Settings Back toward the sidebar's right edge; keep account Back, Search, and Hide Sidebar in one right-aligned group. Add the collapse marker to the account content header and keep its breadcrumb in that row.
- [ ] **Step 4: Run the same tests and confirm pass.** Commit with `fix(desktop): align overlay titlebar rows`.

### Task 2: Native light placement and zoom-safe clearance

**Files:**
- Modify: `apps/desktop-electron/src/window-chrome.js`
- Modify: `apps/desktop-electron/src/window-chrome.test.js`
- Modify: `apps/web/src/app/globals.css`
- Test: `apps/web/src/features/workspace/project-layout/desktop-titlebar.test.ts`

**Interfaces:** `macTrafficLightPosition()` continues to return `{ x, y }` to the BrowserWindow constructor. CSS consumes `--kx-titlebar-inset`, `--kx-titlebar-lights-end`, and `--kx-titlebar-content-left` under `data-desktop-platform='macos'`.

- [ ] **Step 1: Write failing geometry tests.** Pin the empirical native-light offset against the existing project/session centerline, and require the overlay rows to use the same 40px band. Assert collapsed account header starts after `--kx-titlebar-content-left` and fullscreen removes the clearance.
- [ ] **Step 2: Run focused tests to verify failure.** With the repository-supported Node version active, run `pnpm --filter @kortix/desktop-electron test` and the focused web titlebar test.
- [ ] **Step 3: Calibrate only the native macOS light position from a real Electron screenshot.** Update `macTrafficLightPosition()` and its measured-frame comment; retain the 40px web band. Add explicit CSS for the overlay first rows and collapsed header, divided by `--kx-desktop-zoom` where they represent window pixels. Do not alter project/session header position.
- [ ] **Step 4: Run focused tests and inspect the screenshot again.** Commit with `fix(desktop): align native window controls`.

### Task 3: Black-box verification and PR refresh

**Files:**
- Modify: `tests/e2e/specs/27-desktop-parity.spec.ts`
- Update: current draft PR body only if verification or scope changed.

**Interfaces:** Use existing `launchDesktop()`, synthetic auth, and native window access in the desktop parity journey. Do not add a second harness.

- [ ] **Step 1: Replace the obsolete spacer assertion.** Measure first-row and native-light centerlines. Assert expanded and collapsed account hub; Settings; 720 × 480; altered zoom; fullscreen; button clickability. Check the actual breadcrumb bounding box against the native-light safe area.
- [ ] **Step 2: Run the narrow Electron journey.** Use the configured local test profile and report exact pass/fail output. Run focused web tests and desktop tests again, then `pnpm test` if the local stack is available.
- [ ] **Step 3: Inspect real Electron visually.** Compare the project/session, Settings, and account hub expanded/collapsed rows with the supplied reference. Keep screenshots local under ignored `output/`; do not publish personal data.
- [ ] **Step 4: Commit, push only `desktop-hardening`, and refresh its existing stacked draft PR.** Confirm base branch, draft status, and no merge. Update relevant Linear tickets only when the behavior is verified.

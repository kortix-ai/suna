# Smooth shadow source audit

**Date:** 2026-08-06
**Scope:** `apps/web/src`
**Baseline:** `897f7acf6d`
**Inventory command:** `rg -n --glob '*.{ts,tsx,css}' 'shadow(-|\[|\b)|box-shadow|boxShadow' apps/web/src`

## Policy

- Standard elevated surface: `shadow-sm`, `shadow-md`, or `shadow-lg`; no decorative full border or `ring-1`.
- Structural edge: directional border plus explicit ringless `smooth-shadow-*`.
- Semantic state: explicit smooth color or CSS outline; never sacrifice focus or status.
- In-flow surface: flat unless elevation communicates stacking.
- Media: preserve `drop-shadow-*`; use ringless smooth depth for opaque media.

## Inventory summary

The approved design recorded 107 matching files and 43 files with native
`shadow-sm`, `shadow-md`, or `shadow-lg`. After adding the compile contract,
the current tree contains 110 matching files and 45 standard-alias files when
tests are included.

Excluding `*.test.*`, the pre-migration production inventory contains:

| Measure                                             | Count |
| --------------------------------------------------- | ----: |
| Files with any shadow source                        |    99 |
| Lines with any shadow source                        |   210 |
| Files with `shadow-sm`, `shadow-md`, or `shadow-lg` |    41 |
| Lines with `shadow-sm`, `shadow-md`, or `shadow-lg` |    73 |

The source-policy red test found 36 decorative double-edge literals. This is
the migration baseline for Tasks 4–7.

## Standard alias migration

| File                                                           | Category                  | Decision                                                                                            |
| -------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `app/(public)/(marketing)/design-system/page.tsx`              | documentation             | Reduce to the three aliases, remove decorative `ring-1`, and add the explicit escape-hatch example. |
| `app/(public)/voice/[token]/_components/connection-states.tsx` | elevated                  | Remove the decorative full border; keep `shadow-lg`.                                                |
| `app/(public)/voice/[token]/_components/presence-rail.tsx`     | semantic                  | Use ringless `smooth-shadow-md` plus an independent green outline.                                  |
| `app/presentation/deck.tsx`                                    | elevated                  | Remove the toolbar border; keep `shadow-sm`.                                                        |
| `components/announcements/maintenance-banner.tsx`              | semantic                  | Replace tinted borders with `smooth-ring-kortix-*/25`; keep `shadow-lg`.                            |
| `components/dashboard/connecting-screen.tsx`                   | elevated                  | Remove both pill borders; keep `shadow-lg shadow-black/5`.                                          |
| `components/home/interactive-demo/cli/draggable-cli-panel.tsx` | elevated                  | Keep resting `shadow-md`; use explicit smooth ring 2xl while dragging.                              |
| `components/instances/instance-members-panel.tsx`              | semantic/in-flow          | Use an outline plus ringless avatar depth; remove selected role-card depth.                         |
| `components/markdown/docs-mdx-components.tsx`                  | third-party normalization | Keep docs flat and update stale comments only.                                                      |
| `components/projects/personal-onboarding-welcome.tsx`          | structural                | Use ringless `smooth-shadow-sm` on the fixed sidebar seam.                                          |
| `components/ui/alert-dialog.tsx`                               | elevated owner            | Remove the decorative border; keep `shadow-lg`.                                                     |
| `components/ui/command.tsx`                                    | elevated owner            | Remove the nested hover-card border; keep its `shadow-md` override.                                 |
| `components/ui/date-range-picker.tsx`                          | duplicate owner           | Remove caller depth; `PopoverContent` owns it.                                                      |
| `components/ui/dialog.tsx`                                     | elevated owner            | Remove the decorative border; keep `shadow-lg`.                                                     |
| `components/ui/hover-card.tsx`                                 | elevated owner            | Remove the decorative border; keep `shadow-sm`.                                                     |
| `components/ui/menu-recipe.ts`                                 | elevated owner            | Remove the decorative border; keep `shadow-md`.                                                     |
| `components/ui/modal.tsx`                                      | structural owner          | Use ringless `smooth-shadow-lg`; preserve directional seams.                                        |
| `components/ui/preview-image.tsx`                              | full-screen               | Remove depth from the full-screen root.                                                             |
| `components/ui/sheet.tsx`                                      | structural owner          | Use ringless `smooth-shadow-lg`; preserve directional seams.                                        |
| `components/ui/sidebar.tsx`                                    | mixed                     | Remove the floating border, use explicit smooth ring xl for peek, and flatten inset content.        |
| `components/ui/switch.tsx`                                     | compact control           | Use ringless `smooth-shadow-sm` inside the track.                                                   |
| `components/ui/tabs.tsx`                                       | raised active state       | Remove decorative `ring-1`; keep `shadow-sm`.                                                       |
| `components/ui/toast.tsx`                                      | elevated owner            | Remove repeated borders and centralize the `shadow-lg` surface class.                               |
| `components/use-cases/covers.tsx`                              | media/marketing           | Replace native ring pairs with explicit smooth ring utilities and preserve tint.                    |
| `features/file-renderers/docx/docx-annotation-card.tsx`        | elevated                  | Keep `shadow-sm`; no duplicate full border exists.                                                  |
| `features/file-renderers/docx/docx-viewer.tsx`                 | raised active state       | Keep `shadow-sm` over a `border-0 ring-0` base.                                                     |
| `features/file-renderers/image-renderer.tsx`                   | elevated/media            | Remove the control border and use ringless media depth for opaque images.                           |
| `features/file-renderers/shared/document-viewer-sidebar.tsx`   | structural                | Use ringless `smooth-shadow-lg`; preserve `border-r`.                                               |
| `features/file-renderers/sqlite-renderer.tsx`                  | raised active state       | Keep `shadow-sm` on the selected segmented-control item.                                            |
| `features/file-renderers/video-renderer.tsx`                   | elevated control          | Keep `shadow-lg`; no duplicate border exists.                                                       |
| `features/file-viewer/file-preview-modal.tsx`                  | elevated control          | Remove both navigation-button borders; keep `shadow-sm`.                                            |
| `features/marketplace/marketplace-detail.tsx`                  | elevated                  | Remove the fixed toolbar border; keep `shadow-lg`.                                                  |
| `features/marketing/download/card-images.tsx`                  | documentation             | Update the comment only; retain deliberate media framing.                                           |
| `features/marketing/hero-surfaces.tsx`                         | elevated                  | Remove the frame and chip borders; keep the standard aliases.                                       |
| `features/marketing/landing/scroll-cta-pill.tsx`               | elevated                  | Remove the decorative border; keep `shadow-sm`.                                                     |
| `features/review-center/review-center.tsx`                     | elevated                  | Remove the fixed toolbar border; keep `shadow-lg`.                                                  |
| `features/session/action-panel/easy/panel-card.tsx`            | documentation             | Update the stale recipe comment only.                                                               |
| `features/session/scope/session-scope-control.tsx`             | duplicate owner           | Remove caller depth; `PopoverContent` owns it.                                                      |
| `features/workspace/customize/migrate-to-v2/upgrade-view.tsx`  | semantic                  | Replace the tinted border with a tinted smooth ring.                                                |
| `features/workspace/project-sidebar/project-switcher.tsx`      | duplicate owner           | Remove caller depth; `DropdownMenuContent` owns it.                                                 |

Negative assertions in `get-mem-tool.test.tsx` and
`memory-search-tool.test.tsx` remain unchanged. They verify that in-flow memory
results stay flat.

## Explicit utilities retained

The following non-standard uses were reviewed before migration.

### Structural or compact control depth

- `components/ui/button-group.tsx`
- `components/ui/button.tsx`
- `components/ui/checkbox.tsx`
- `components/ui/command.tsx`
- `components/ui/input-group.tsx`
- `components/ui/radio-group.tsx`
- `components/ui/scroll-area.tsx`
- `components/ui/slider-native.tsx`
- `components/ui/slider.tsx`
- `components/ui/trigger-variants.ts`
- `features/file-renderers/shared/document-viewer-sidebar.tsx`
- `features/file-renderers/shared/scroll-area-compat.tsx`
- `features/session/action-panel/shared/action-navigator.tsx`

Native `shadow-xs` and inset or arbitrary shadows in this group are compact
component details. They do not use the three standard elevated-surface aliases.

### Explicit elevated surfaces

- `app/(system)/debug/connecting/page.tsx`
- `components/home/interactive-demo/cli/draggable-cli-panel.tsx`
- `components/ui/chart.tsx`
- `components/ui/navigation-menu.tsx`
- `components/ui/sidebar.tsx`
- `features/file-viewer/file-preview-modal.tsx`
- `features/session/action-panel/easy/panel-card.tsx`
- `features/session/session-chat.tsx`
- `features/session/tool/shared/infrastructure.tsx`

Existing `shadow-xl`, `shadow-2xl`, and reviewed arbitrary stacks in this group
represent non-standard floating windows, debug surfaces, or compatibility
layers. New changes use the plugin's explicit sizes where a migrated standard
alias would otherwise stack with them.

### Semantic state or focus treatment

- `components/file-editors/codemirror-diagnostics.ts`
- `components/ui/emoji-picker.tsx`
- `components/ui/entity-avatar.tsx`
- `components/ui/glyph-picker.tsx`
- `components/ui/tabs.tsx`
- `features/projects/modal/project-icon-field.tsx`

These shadows or `boxShadow` values communicate focus, diagnostics, selection,
or color state. The migration does not remove the state. Where a standard
alias shares the element, the state moves to an outline or smooth-ring color.

### Media and marketing treatment

- `components/blog/blog-cover.tsx`
- `components/referrals/referral-email-invitation.tsx`
- `components/ui/marketing/button.tsx`
- `features/billing/pricing-plan-card.tsx`
- `features/file-renderers/csv/csv-viewer.tsx`
- `features/file-renderers/docx/docx-viewer.tsx`
- `features/file-renderers/pdf/pdf-viewer.tsx`
- `features/file-renderers/xlsx/xlsx-viewer.tsx`
- `features/marketing/landing/use-case-wheel.tsx`
- `features/project-files/components/drive-explorer.tsx`
- `features/project-files/components/drive-grid-view.tsx`
- `features/project-files/components/file-explorer-page.tsx`
- `features/project-files/components/file-search.tsx`

`drop-shadow-*` remains unchanged because it follows alpha. Image, document,
and marketing-frame box shadows remain explicit only where their edge is not a
standard application overlay.

### Contract and documentation sources

- `app/globals.css`
- `app/(public)/(marketing)/design-system/page.tsx`
- `components/ui/emoji-picker.test.tsx`
- `components/ui/entity-avatar.test.tsx`
- `features/projects/modal/project-icon-field.test.tsx`

These files define or test the design system. They are not additional runtime
elevation owners.

## Verification evidence

| Gate                     | Evidence                                                                |
| ------------------------ | ----------------------------------------------------------------------- |
| Baseline web suite       | 4572 pass, 2 fail. Both customize-overlay failures reproduce on `main`. |
| Global adapter           | `cbbc240636`; 4 pass, 0 fail, 21 assertions.                            |
| Edge-policy red state    | 36 violations found before migration.                                   |
| Component migration      | Open; Tasks 4–7 remove the recorded violations.                         |
| Headless local visual QA | Open until the migrated design-system route is available.               |
| PR and merge             | Open until all local gates pass.                                        |
| Deploy Dev and dev QA    | Open until the merged SHA is deployed.                                  |

## Linear

- Project: [Smooth Shadow System — Web](https://linear.app/sutharjay/project/smooth-shadow-system-web-8db242952484)
- Specification: [Smooth Shadow System — Specification](https://linear.app/sutharjay/document/smooth-shadow-system-specification-488c801cfd3e)
- Plan: [Smooth Shadow System — Implementation Plan](https://linear.app/sutharjay/document/smooth-shadow-system-implementation-plan-944902f82677)
- `JAY-416` — global adapter
- `JAY-417` — merge and edge contracts
- `JAY-418` — shared primitives
- `JAY-419` — product and media surfaces
- `JAY-420` — public and marketing surfaces
- `JAY-421` — documentation and visual verification
- `JAY-422` — merge, deploy, and dev verification

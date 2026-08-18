# Capability Hero Product Collage

## Goal

Replace the shared capability hero fact grid with a dense Dovetail-inspired masonry wall. The collage must show product-shaped evidence for each capability without changing the existing hero copy or calls to action.

## Composition

The wide desktop hero remains a two-column layout. Copy stays on the left. Twelve artifact tiles fill four staggered columns on the right. Each column starts at a different vertical offset, and tile heights vary. The wall continues below the hero crop like the Dovetail reference.

Tablet and small screens show the first six tiles in a compact two-column grid. The wide layout starts at `xl`, which prevents long hero copy from being squeezed or clipped at 1024 px. The hero uses a minimum height on narrow screens and preserves the existing `80dvh` composition on wide desktop.

## Artifacts

Each existing capability fact declares one of four visual treatments. The renderer expands those four factual inputs into three presentation modes, producing 12 tiles without adding unsupported claims:

- `status`: live or available product state.
- `terminal`: a command, configuration value, or runtime surface.
- `flow`: a bounded sequence or relationship.
- `review`: a policy, approval, or change-request gate.

Presentation modes are full product artifact, compact fact tile, and visual signal tile.

The factual `k` and `v` strings remain the source of truth. The visual treatment adds product context without introducing new claims.

## Motion

The cards enter separately with a 35 ms stagger. The collage has no cursor-following, hover tilt, or depth response.

Only opacity and transforms animate during entrance. `prefers-reduced-motion` removes positional motion and leaves the static collage.

## Accessibility

The collage is descriptive, not interactive. Existing calls to action retain keyboard and focus behavior. Artifact text remains real text. Decorative lines and nodes stay hidden from assistive technology. Motion is not the only carrier of information.

## Verification

- Render at 375 px, 768 px, 1024 px, and 1440 px.
- Confirm all four artifact values remain readable on each capability page.
- Confirm the desktop scene renders 12 tiles in four staggered columns.
- Confirm touch and reduced-motion modes remain static after entrance.
- Run targeted ESLint and TypeScript checks.

import type { NoiseRule } from '../evidence';
import { isFirstPartyResolvedSource, normalizeString, stripErrorWrappers } from '../evidence';
import { REACT_UPDATE_DEPTH_NOISE_PATTERN } from './react';

// React #185 = "Maximum update depth exceeded" — the canonical React infinite-
// setState-loop error. The `@embedpdf/plugin-tiling` `TilingLayer` React
// component (used by `apps/web/src/components/ui/extend/pdf-viewer.tsx`'s
// `<TilingLayer>`) subscribes to the tiling plugin's `onTileRendering` event
// and calls `setTiles(event.tiles[pageIndex] ?? [])` on every emission. Under
// a rapid zoom/scroll burst the tiling plugin emits `onTileRendering`
// synchronously inside the React commit phase (a tile render resolves
// synchronously from cache and re-emits), so `setTiles` is called during
// commit → re-render → `TileImg` re-renders → `renderTile` → `onTileRendering`
// → `setTiles` → … → React's 50-nested-update guard trips React #185. The
// throw is INSIDE @embedpdf's bundled `TilingLayer`/`TileImg` (frame
// `Object.r [as onTileRendering]` in a `_next/static/chunks/…` bundle), never
// in first-party `apps/web/src/…` source. Better Stack pattern
// 366115d4c931a6352fe8f334ff1b366f6d4b2ce9c192769ac681831354521e30
// (Kortix Frontend prod, application_id 2346967): 1 occurrence, 0 identified
// users, 2026-07-15 09:36:41 UTC, route `/projects/:id/sessions/:sessionId`,
// Chrome 142 / Windows 10. A transient third-party render loop, not a
// deterministic app regression (single occurrence, no identified users, no
// first-party frame, no spike on a release across browsers).
//
// React #185 is ALSO the exact message a REAL first-party infinite-setState
// loop produces, so this matcher is anchored on BOTH the #185 message AND a
// frame whose function is `onTileRendering` (the @embedpdf tiling subscription
// callback — never present in first-party code), AND a NEGATIVE guard: if any
// frame resolves to a de-minified first-party `apps/web/src/…` source, the
// event keeps reporting — that means our own component is the looping culprit
// and is actionable to fix. A real first-party #185 surfaces with a resolved
// `apps/web/src/…` frame (or at least no `onTileRendering` frame) and is
// preserved; a #185 from a DIFFERENT third-party lib (no `onTileRendering`
// frame) is preserved too. Only the @embedpdf-tiling #185 class is dropped.
// Deliberately NOT added to `sentry.client.config.ts`'s `ignoreErrors` list —
// that gate has no frame context, so a bare `#185` match there would swallow a
// real first-party setState loop; the frame-aware `beforeSend` hook (which
// calls `shouldIgnoreSentryBrowserNoise`) is the only safe gate. The #185
// pattern itself, `REACT_UPDATE_DEPTH_NOISE_PATTERN`, lives in `react.ts`.
//
// The @embedpdf/plugin-tiling `TilingLayer` subscription callback frame. The
// function name `onTileRendering` is the tiling plugin's own event name (see
// `@embedpdf/plugin-tiling`'s `TilingLayer` → `tilingProvides.onTileRendering`);
// it never appears in first-party `apps/web/src/…` source, so its presence is a
// specific third-party anchor.
const EMBEDPDF_TILING_CALLBACK_FRAME_MARKER = 'onTileRendering';

function frameMatchesEmbedPdfTilingCallback(frame: { function?: unknown } | undefined): boolean {
  return normalizeString(frame?.function).includes(EMBEDPDF_TILING_CALLBACK_FRAME_MARKER);
}

/**
 * Whether a Sentry exception is the `@embedpdf/plugin-tiling` `TilingLayer`
 * React #185 "Maximum update depth exceeded" render-loop class: a
 * `Minified React error #185` thrown from inside the tiling plugin's
 * `onTileRendering` subscription callback (frame `Object.r [as
 * onTileRendering]` in a `_next/static/chunks/…` bundle) with NO resolved
 * first-party `apps/web/src/…` frame. The tiling plugin re-emits
 * `onTileRendering` synchronously during the React commit phase under a rapid
 * zoom/scroll burst, so its `setTiles` runs during commit → re-render →
 * `renderTile` → re-emit → React's 50-nested-update guard trips #185. The
 * throw is in third-party bundled code, never first-party. Requires BOTH the
 * #185 message AND an `onTileRendering` frame, AND a NEGATIVE guard: if any
 * frame resolves to a de-minified first-party `apps/web/src/…` source, the
 * event keeps reporting (our own component is the looping culprit →
 * actionable). A real first-party #185, or a #185 from a different third-party
 * lib, is never matched. Returns false when there are no frames (can't confirm
 * the tiling anchor — keep reporting). See
 * `REACT_UPDATE_DEPTH_NOISE_PATTERN` for the full rationale.
 */
export function isEmbedPdfTilingReactUpdateDepthNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown } | undefined>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (!REACT_UPDATE_DEPTH_NOISE_PATTERN.test(message)) {
    return false;
  }
  const frames = input.frames ?? [];
  if (frames.length === 0) {
    return false;
  }
  // Negative guard: a resolved first-party frame means our own component is the
  // looping culprit → actionable; keep reporting so the call site can be found.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Anchor: the throw must be inside @embedpdf/plugin-tiling's `onTileRendering`
  // subscription callback. This frame is never present in first-party code, so a
  // real first-party #185 (or a #185 from a different third-party lib) is never
  // matched.
  return frames.some(frameMatchesEmbedPdfTilingCallback);
}

// The EXACT V8 wording of the @embedpdf/plugin-tiling `TilingLayer` viewport-
// advance tile-destructure throw: under a rapid scroll/zoom burst the tiling
// plugin's tile queue drains mid-burst, the viewport-advance path calls
// `const { tile } = queue.pop()` on an `undefined` pop result, and V8 reports
// `Cannot destructure property 'tile' of 'r.pop(...)' as it is undefined.` (the
// minified queue is `r`, so the destructure target renders as `r.pop(...)`).
// The `tile` property name + the `r.pop(...)` destructure target together pin
// this single call site; a different destructure (different property / different
// expression) is a different throw and must keep reporting. Anchored as an EXACT
// string match (after `stripErrorWrappers`) like the Paper Shaders patterns —
// not a loose prefix — so a near-worded regression cannot slip through.
const EMBEDPDF_TILING_TILE_DESTRUCTURE_NOISE_MESSAGE =
  "Cannot destructure property 'tile' of 'r.pop(...)' as it is undefined.";

// The @embedpdf/plugin-tiling `TilingLayer` viewport-advance internal frame
// anchors. Under a scroll/zoom burst the tiling plugin's viewport advance path
// (`t5.advance` → `iA.ignore` → `iA.onScroll` / `iA.onScrollChanged`, plus the
// `IntersectionObserver` threshold callback that drives viewport recomputation)
// pops the drained tile queue. These minified function names are the tiling
// plugin's own viewport-advance internals (never present in first-party
// `apps/web/src/…` source), so their presence is a specific third-party anchor.
// Function names are stable across deploys (unlike the `c63a46fc` chunk hash,
// which changes every release), so they are the primary anchor; the chunk hash
// is a fallback for captures whose function names were stripped.
const EMBEDPDF_TILING_VIEWPORT_ADVANCE_FRAME_MARKERS = [
  't5.advance',
  'iA.ignore',
  'iA.onScroll',
  'iA.onScrollChanged',
  'IntersectionObserver.intersection.IntersectionObserver.threshold',
] as const;

// The minified @embedpdf/plugin-tiling tiling chunk hash seen in both prod
// patterns (`c63a46fc-270e35c76d7636cb.js`). Changes per deploy, so it is a
// fallback anchor only — the function-name markers above are preferred.
const EMBEDPDF_TILING_CHUNK_MARKER = 'c63a46fc';

function frameMatchesEmbedPdfTilingViewportAdvance(
  frame: { filename?: unknown; function?: unknown } | undefined,
): boolean {
  const fn = normalizeString(frame?.function);
  if (EMBEDPDF_TILING_VIEWPORT_ADVANCE_FRAME_MARKERS.some((marker) => fn.includes(marker))) {
    return true;
  }
  return normalizeString(frame?.filename).includes(EMBEDPDF_TILING_CHUNK_MARKER);
}

/**
 * Whether a Sentry exception is the `@embedpdf/plugin-tiling` `TilingLayer`
 * viewport-advance tile-destructure noise class: under a rapid scroll/zoom
 * burst the tiling plugin's tile queue drains mid-burst, the viewport-advance
 * path (`t5.advance` / `iA.ignore` / `iA.onScroll` / `iA.onScrollChanged` /
 * `IntersectionObserver.threshold`) calls `const { tile } = queue.pop()` on an
 * `undefined` pop result, and V8 throws
 * `Cannot destructure property 'tile' of 'r.pop(...)' as it is undefined.` The
 * throw is in third-party bundled code (the minified `c63a46fc` tiling chunk),
 * never first-party. This is a SIBLING of the React #185 render-loop class
 * (`isEmbedPdfTilingReactUpdateDepthNoise`, Better Stack pattern `366115d4…`,
 * PR #4718) but a DIFFERENT throw from a different embedpdf tiling path (the
 * viewport-advance path, not the `onTileRendering` subscription callback), so the
 * #4718 matcher — anchored on the `Minified React error #185` message + the
 * `onTileRendering` frame — does NOT catch it. Requires BOTH the EXACT message
 * AND a positive viewport-advance frame anchor (function name or the
 * `c63a46fc` tiling chunk), AND a NEGATIVE guard: if any frame resolves to a
 * de-minified first-party `apps/web/src/…` source, the event keeps reporting (a
 * real first-party `{ tile } = arr.pop()` regression de-minifies to
 * `apps/web/src/…` and must not be hidden). The `tile` property name is part of
 * the anchor, so a different destructure (`{ foo } = r.pop()`) keeps reporting.
 * Returns false when there are no frames (can't confirm the tiling anchor — keep
 * reporting). See Better Stack patterns `3e579401…` / `70272e1e…`.
 */
export function isEmbedPdfTilingTileDestructureNoise(input: {
  message?: unknown;
  frames?: Array<{ filename?: unknown; function?: unknown } | undefined>;
}): boolean {
  const message = stripErrorWrappers(normalizeString(input.message));
  if (message !== EMBEDPDF_TILING_TILE_DESTRUCTURE_NOISE_MESSAGE) {
    return false;
  }
  const frames = input.frames ?? [];
  if (frames.length === 0) {
    return false;
  }
  // Negative guard: a resolved first-party frame means our own code is the
  // destructure culprit → actionable; keep reporting so the call site can be
  // found. A real first-party `{ tile } = arr.pop()` regression de-minifies to
  // `apps/web/src/…` and must never be hidden.
  if (frames.some((frame) => isFirstPartyResolvedSource(frame?.filename))) {
    return false;
  }
  // Anchor: the throw must be inside @embedpdf/plugin-tiling's viewport-advance
  // path. These frames are never present in first-party code, so a real
  // first-party tile-destructure (or a same-worded throw from a different
  // third-party lib) is never matched.
  return frames.some(frameMatchesEmbedPdfTilingViewportAdvance);
}

export const PDF_RULES: readonly NoiseRule[] = [
  {
    id: 'embedpdf-tiling-update-depth',
    appliesTo: 'sentry',
    match: isEmbedPdfTilingReactUpdateDepthNoise,
  },
  {
    id: 'embedpdf-tile-destructure',
    appliesTo: 'sentry',
    match: isEmbedPdfTilingTileDestructureNoise,
  },
];

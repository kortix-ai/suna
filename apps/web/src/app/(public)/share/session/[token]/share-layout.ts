/**
 * Layout class names for the public session share surface.
 *
 * The share page is a fixed header above a single full-bleed region that hosts
 * an iframe — either a live preview or a rendered HTML file. For that iframe to
 * fill the region (full width AND full height), every ancestor in the chain has
 * to hand down a *definite* height. A `min-h-*` (minimum) height does not let
 * `h-full` / `flex-1` descendants resolve to pixels, so the iframe silently
 * collapses to its intrinsic height and the content is clipped.
 *
 * The page root therefore pins a definite viewport height (`h-dvh`, the dynamic
 * viewport so the bottom isn't hidden behind mobile browser chrome), and each
 * iframe claims the full box. Keep these as the single source of truth so the
 * height chain can never silently regress back to a minimum height.
 */

// Page root: definite viewport height so the flex chain resolves to real pixels.
export const SHARE_PAGE_ROOT_CLASS = 'bg-background text-foreground flex h-dvh flex-col';

// Live preview iframe: fills its flex-1 region edge to edge.
export const SHARE_PREVIEW_IFRAME_CLASS = 'h-full w-full border-0';

// HTML file iframe: sits below a fixed toolbar inside a flex-col, so it takes
// the remaining height (flex-1) and spans the full width.
export const SHARE_FILE_IFRAME_CLASS = 'min-h-0 w-full flex-1 border-0 bg-white';

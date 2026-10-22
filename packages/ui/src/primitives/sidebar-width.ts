/**
 * Sidebar width: the numbers, the clamp, and the cookie.
 *
 * Kept framework-free (same shape as `sidebar-peek.ts`) so the ratio rules are
 * testable without React, a DOM, or a viewport.
 *
 * The ratio, stated once so it stops being folklore:
 *
 * | Bound   | Value          | Why                                              |
 * |---------|----------------|--------------------------------------------------|
 * | default | 20rem / 320px  | 25% of a 1280px viewport — one session title fits on one line |
 * | min     | 13rem / 208px  | below this the session rows truncate to nothing   |
 * | max     | 26rem / 416px  | above this the panel stops reading as a rail      |
 * | cap     | 32% of the viewport | the panel may never own a third of the screen |
 *
 * `max` and `cap` are both ceilings and the SMALLER wins, so a 1024px laptop
 * tops out at 328px while a 1600px display tops out at 416px. `min` always
 * wins last: a narrow viewport clamps to 208px rather than producing an
 * inverted range.
 */

/** Default docked width. Keep in sync with `SIDEBAR_WIDTH` (`20rem`). */
export const SIDEBAR_WIDTH_PX = 320;
export const SIDEBAR_MIN_WIDTH_PX = 208;
export const SIDEBAR_MAX_WIDTH_PX = 416;
/** The panel may never own more than this fraction of the viewport. */
export const SIDEBAR_MAX_WIDTH_RATIO = 0.32;

/** Drag lands on the default width when it comes within this many px of it. */
export const SIDEBAR_WIDTH_SNAP_PX = 12;

export const SIDEBAR_WIDTH_COOKIE_NAME = 'sidebar_width';

/**
 * Largest width allowed at this viewport. `Math.max(MIN, …)` keeps the range
 * non-inverted on viewports narrow enough that the ratio cap falls under the
 * minimum — the desktop sidebar is hidden below `md` anyway, but a clamp that
 * can return a max below its own min is a bug waiting for a resize event.
 */
export function maxSidebarWidth(viewportWidth: number): number {
  const ratioCap = Math.floor(viewportWidth * SIDEBAR_MAX_WIDTH_RATIO);
  return Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX_WIDTH_PX, ratioCap));
}

/**
 * Clamp a proposed width into the allowed range, with a magnetic snap onto the
 * default so "put it back how it was" costs no precision. The snap is applied
 * before the clamp so it can never pull a value outside the range.
 */
export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const snapped =
    Math.abs(width - SIDEBAR_WIDTH_PX) <= SIDEBAR_WIDTH_SNAP_PX ? SIDEBAR_WIDTH_PX : width;
  return Math.round(
    Math.min(Math.max(snapped, SIDEBAR_MIN_WIDTH_PX), maxSidebarWidth(viewportWidth)),
  );
}

/**
 * Read the persisted width out of a cookie string. Returns `null` when absent
 * or unparseable so callers fall back to the default rather than to `NaN` —
 * a `NaN` here would render `--sidebar-width: NaNpx` and collapse the panel.
 */
export function parseSidebarWidthCookie(cookie: string | null | undefined): number | null {
  if (!cookie) return null;
  const match = cookie.match(/(?:^|;\s*)sidebar_width=(\d{2,4})\b/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

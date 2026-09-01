/**
 * The chrome a project-home band wears, in one place.
 *
 * Two bands occupy the SAME slot under the composer and only one is ever
 * mounted: the setup checklist (`setup-checklist.tsx`) while there are open
 * steps, and the starter prompts (`starter-prompt-band.tsx`) once there are
 * not. They have to be the same object changing its contents, not two panels
 * that happen to look similar — so the classes live here rather than being
 * typed out twice and drifting the first time one of them is nudged.
 *
 * Plain string constants, not a component: the checklist's panel is a
 * `motion` section with its own enter/exit and the starter band is a static
 * one, so a shared wrapper component would have to take enough props to
 * reconstruct both. The values are what is shared; the elements are not.
 *
 * Every value is a token — see `.claude/skills/kortix-brand-guidelines`. Note
 * `--spacing: 0.23rem`, so `py-2` is 7.4px and `pl-4` is 14.7px, not 8 and 16.
 */

/**
 * The panel itself. Flat on the page — no border, no card — the way the
 * reference lays it out. The translucent wash is the one concession: this sits
 * over the animated wallpaper (`ProjectHomeWallpaper`) and legibility outranks
 * flatness.
 */
export const BAND_PANEL_CLASS = 'bg-background/70 w-full rounded-md pb-2 backdrop-blur-sm';

/** The band's header line: title on the left, anything else trailing. */
export const BAND_HEADER_CLASS = 'flex items-center gap-2 py-2 pr-2 pl-4';

/** The header's title. `flex-1` so trailing controls sit hard right. */
export const BAND_TITLE_CLASS = 'text-foreground flex-1 text-sm font-medium';

/** The list the rows sit in. */
export const BAND_LIST_CLASS = 'flex flex-col px-2';

/**
 * One row.
 *
 * `gap-2` after a `size-4.5` leading glyph is what puts every label on the
 * same vertical line — the checklist's done/pending indicator and a starter
 * prompt's own icon are both drawn in that box, at that size, so the two bands
 * share a text rail as well as a panel edge.
 */
export const BAND_ROW_CLASS = 'flex items-center gap-2 rounded-md py-2 pr-4 pl-2.5';

/** A row that responds to the pointer. Named property, never `transition-all`. */
export const BAND_ROW_HOVER_CLASS = 'hover:bg-hover transition-colors duration-fast ease-out';

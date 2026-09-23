/**
 * The conversation column: max width, centring, and gutters.
 *
 * 12px more inset than the composer on both sides (`COMPOSER_SHELL_CLASS` is
 * `px-4`), so the input card reads slightly WIDER than the conversation and a
 * right-aligned bubble never sits flush with the card's edge. `pt-6` and NO
 * bottom padding: the space under the last message is the auto-scroll
 * spacer's job alone (use-auto-scroll.ts).
 *
 * The gutters are equal on both sides at every width. The collapsed
 * action-panel rail takes no layout width (see `COLLAPSED_RAIL_OFFSET` in
 * `session-action-panel-column.tsx`), so the chat column spans the full row
 * and equal gutters put the conversation on the row's exact center.
 *
 * Its own module with no imports, so a surface that only needs the column (the
 * first chat on project home) does not pull `session-body.tsx`'s action panel
 * into its bundle. `session-body.tsx` re-exports it for the session surfaces.
 */
export const SESSION_TRANSCRIPT_CLASS = 'mx-auto w-full max-w-3xl min-w-0 px-7 pt-6';

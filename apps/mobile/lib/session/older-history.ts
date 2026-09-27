/**
 * The "Show 100 earlier messages" control at the top of a long thread
 * (COR-144). A session opens with its newest page only
 * (`session-sync-controller.ts` in `@kortix/sdk`); this control pulls the
 * next older page through the controller's `loadOlder`.
 *
 * Pure: `bun test` covers it. `SessionPage` renders the result.
 */

/**
 * Messages per older page. Mirrors the SDK's `SESSION_SYNC_PAGE_SIZE`, which
 * `@kortix/sdk` does not export from its root. `loadOlder` may read a little
 * past it to complete a turn cut in half at the page edge.
 */
export const OLDER_PAGE_SIZE = 100;

/**
 * How long the list keeps its visible turn pinned after an older page lands:
 * long enough for the prepended turns to lay out.
 */
export const OLDER_HOLD_POSITION_MS = 600;

export interface OlderHistoryInput {
  /** The sync controller holds a cursor to an older page. */
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /** Turns the thread shows now. */
  turnCount: number;
}

export interface OlderHistoryControl {
  label: string;
  disabled: boolean;
}

/** The control to render, or `null` when there is nothing older to load. */
export function olderHistoryControl(input: OlderHistoryInput): OlderHistoryControl | null {
  if (!input.hasOlder || input.turnCount === 0) return null;
  if (input.isLoadingOlder) return { label: 'Loading earlier messages…', disabled: true };
  return { label: `Show ${OLDER_PAGE_SIZE} earlier messages`, disabled: false };
}

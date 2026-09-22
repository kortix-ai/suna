/**
 * The shape every "pick a session" surface needs, and nothing more.
 *
 * The command palette, the @-mention autocomplete and the tabs overview all
 * used to take the OpenCode `Session` type straight from the sandbox — an id, a
 * title, and a `time.archived` flag. That tied three pieces of UI to a runtime
 * wire format, and it meant a session that was not currently running could not
 * appear in any of them, because the list came from the sandbox.
 *
 * They now take this instead, projected from the Kortix session row. A stopped
 * session is still a session, so it still appears.
 */

import type { ProjectSession } from '@kortix/sdk';

export interface SessionPickerItem {
  /** Kortix session id — the same id `SessionPage` is addressed by. */
  id: string;
  /** Display name, already resolved through the row's fallbacks. */
  title: string;
  /** Epoch ms, for recency ordering. */
  updatedAt: number;
  /**
   * The session's canonical OpenCode root id, or null before `/start` has
   * resolved one.
   *
   * Needed because the SDK's transcript store is keyed by the RUNTIME id, not
   * the Kortix id — a surface that wants this session's messages (the tabs
   * overview's preview line) must translate through this. Everything else
   * addresses the session by `id`.
   */
  runtimeSessionId: string | null;
}

/**
 * Newest first — every consumer wants recency, and doing it once here stops
 * three surfaces from each sorting a different way.
 */
export function toSessionPickerItems(rows: readonly ProjectSession[]): SessionPickerItem[] {
  return rows
    .map((row) => ({
      id: row.session_id,
      // `name` already resolves custom name → runtime title → generated title;
      // the branch is the last honest fallback for a session that has not been
      // named or prompted yet.
      title: row.name || row.branch_name || 'New session',
      updatedAt: Date.parse(row.updated_at) || 0,
      runtimeSessionId: row.opencode_session_id,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

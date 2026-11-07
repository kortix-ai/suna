/**
 * Names the space watcher (flag `spaces_proactive`) shares with the session
 * create path. Kept apart from the watcher's services so `session-create.ts`
 * imports no session-lifecycle code through it.
 */

/** The session source of a space's watcher. Only the API's own create uses it. */
export const SPACE_WATCHER_SOURCE = 'system:space-watcher' as const;

/** The runtime_context key kortixd reads (`harness/pi/watcher.ts`): no tools, the watcher's system prompt. Reserved (`kortix.`). */
export const WATCHER_CONTEXT_KEY = 'kortix.watcher';

/** Session metadata of a watcher: the space it watches. Server-managed. */
export const WATCHER_SPACE_METADATA_KEY = 'space_watcher';

/** Session metadata of a top-level post the watcher made: its "Your recent posts" reads them. */
export const WATCHER_POST_METADATA_KEY = 'space_watcher_post';

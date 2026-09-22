/**
 * project-stack — route names and navigation decisions for the stack inside
 * `/projects/[id]` (components/session/ProjectRoutes, ProjectScreen).
 *
 * The stack is never deeper than one screen over project home: `[index]` or
 * `[index, X]`, where X is a covering route (view, sessions, files, account).
 * The drawer opens on every project route, so a drawer destination replaces
 * a covering route instead of pushing over it.
 *
 * Pure: no React, React Native, or expo imports (unit-tested under bun test).
 */

/** Project home. */
export const PROJECT_HOME_ROUTE = 'index';
/** The open page, thread, or connecting session. */
export const PROJECT_VIEW_ROUTE = 'view';
/** Every session of the project. */
export const PROJECT_SESSIONS_ROUTE = 'sessions';
/** The project's files. */
export const PROJECT_FILES_ROUTE = 'files';
/** The Account page, opened from the drawer avatar. */
export const PROJECT_ACCOUNT_ROUTE = 'account';

/** A route the drawer opens by name. */
export type ProjectDrawerRoute =
  | typeof PROJECT_SESSIONS_ROUTE
  | typeof PROJECT_FILES_ROUTE
  | typeof PROJECT_ACCOUNT_ROUTE;

/**
 * The drawer opens `route`. `top` is the focused project route, or null before
 * the stack's first focus event (the stack starts on project home).
 * - home on top → `push`
 * - `route` already on top → `none`
 * - another covering route on top → `replace` it
 */
export function drawerRouteMove(
  top: string | null,
  route: ProjectDrawerRoute
): 'push' | 'replace' | 'none' {
  if (top === null || top === PROJECT_HOME_ROUTE) return 'push';
  if (top === route) return 'none';
  return 'replace';
}

/** Return to project home (New session): pop a covering route, if any. */
export function returnHomeMove(top: string | null): 'pop-home' | 'none' {
  return top === null || top === PROJECT_HOME_ROUTE ? 'none' : 'pop-home';
}

/**
 * Android hardware back on a project route.
 * - drawer open → `close-drawer`
 * - a covering route on top → `pop-home`
 * - project home → `home` (never pop below the project; see ProjectScreen)
 */
export function androidBackMove(
  top: string | null,
  drawerOpen: boolean
): 'close-drawer' | 'pop-home' | 'home' {
  if (drawerOpen) return 'close-drawer';
  return returnHomeMove(top) === 'pop-home' ? 'pop-home' : 'home';
}

/**
 * A tool page and a thread share the `view` route, and opening a page clears
 * the store's active thread. So the thread a page was opened over is
 * remembered here, for the way back. `activeSessionId` and `activePageId` are
 * the store's values before the page opens; `current` is the remembered thread.
 * - a thread is shown → remember it
 * - a page is shown → keep the thread that page was opened over
 * - project home → nothing to return to
 */
export function returnThreadForPage(state: {
  activeSessionId: string | null;
  activePageId: string | null;
  current: string | null;
}): string | null {
  if (state.activePageId) return state.current;
  return state.activeSessionId;
}

/**
 * Back from the view (Android back, a page's own back control): a page opened
 * over a thread returns to that thread. Everything else returns to project home.
 */
export function pageBackMove(state: {
  activePageId: string | null;
  returnThreadId: string | null;
}): 'return-to-thread' | 'home' {
  return state.activePageId && state.returnThreadId ? 'return-to-thread' : 'home';
}

/**
 * The project session whose content the view shows, or null. Same order as
 * the view's render: the tabs overview and a tool page cover everything, then
 * a thread (its project session id), then a connecting session.
 */
export function shownProjectSessionId(state: {
  showTabsOverview: boolean;
  activePageId: string | null;
  /** The open thread's project session id (not the OpenCode id). */
  threadSessionId: string | null;
  connectingSessionId: string | null;
}): string | null {
  if (state.showTabsOverview || state.activePageId) return null;
  return state.threadSessionId ?? state.connectingSessionId ?? null;
}

/**
 * A drawer session row was tapped. The row of the session already on screen
 * only closes the drawer: reopening it would remount the thread and rerun the
 * connect loop.
 */
export function drawerSessionRowMove(
  rowSessionId: string,
  shownSessionId: string | null
): 'close' | 'open' {
  return rowSessionId === shownSessionId ? 'close' : 'open';
}

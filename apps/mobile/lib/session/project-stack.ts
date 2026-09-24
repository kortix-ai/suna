/**
 * project-stack — route names and navigation decisions for the stack inside
 * `/projects/[id]` (components/session/ProjectRoutes, ProjectScreen).
 *
 * The stack is `[index]`, `[index, X]`, or `[index, X, page, …]`: X is a
 * covering route (view, sessions, files, account), and `page` is a sub-page
 * pushed from the page under it (Settings → project Settings → Schedules).
 * A drawer destination replaces a covering route instead of pushing over it,
 * and drops any sub-pages, so the drawer never deepens the stack. Only a
 * sub-page open deepens it, and back pops exactly one level.
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
/**
 * A sub-page, pushed over the page it was opened from. Its `pageId` param
 * picks the page and never changes, so the route under it keeps its content
 * and its state.
 */
export const PROJECT_PAGE_ROUTE = 'page';

/**
 * The pages that open as sub-pages: project Settings (from Settings) and its
 * Customize rows, Schedules, Secrets and Members. Tab-store page ids.
 */
export const SUB_PAGE_IDS = ['page:settings', 'page:schedules', 'page:secrets-nav', 'page:members'] as const;
export type SubPageId = (typeof SUB_PAGE_IDS)[number];

/** True for a page id that opens as a sub-page (the `page` route's param). */
export function isSubPageId(pageId: string | null | undefined): pageId is SubPageId {
  return (SUB_PAGE_IDS as readonly string[]).includes(pageId ?? '');
}

/** A route the drawer opens by name. */
export type ProjectDrawerRoute =
  | typeof PROJECT_SESSIONS_ROUTE
  | typeof PROJECT_FILES_ROUTE
  | typeof PROJECT_ACCOUNT_ROUTE;

/**
 * The drawer opens `route`. `stack` is the project stack's route names,
 * bottom first, or null before the stack's first focus event (the stack
 * starts on project home). The rules read the routes over project home (the
 * whole stack for a deep link that did not start on home):
 * - nothing over home → `push`
 * - `route` alone → `none`
 * - another covering route alone → `replace` it
 * - `route` with sub-pages over it → `pop-to` route (the sub-pages go)
 * - another route with sub-pages over it → `reset` to `[index, route]`
 */
export function drawerRouteMove(
  stack: readonly string[] | null,
  route: ProjectDrawerRoute
): 'push' | 'replace' | 'none' | 'pop-to' | 'reset' {
  if (stack === null) return 'push';
  const above = stack[0] === PROJECT_HOME_ROUTE ? stack.slice(1) : stack;
  if (above.length === 0) return 'push';
  if (above.length === 1) return above[0] === route ? 'none' : 'replace';
  return above[0] === route ? 'pop-to' : 'reset';
}

/**
 * Open a sub-page (`pageId`) over the focused project route. `top` is that
 * route (its name, and its `pageId` param when it is a sub-page), or null
 * before the stack's first focus event.
 * - the same sub-page already on top (a double tap) → `none`
 * - otherwise → `push`
 */
export function subPageOpenMove(
  top: { name: string; pageId?: string | null } | null,
  pageId: SubPageId
): 'push' | 'none' {
  if (top === null) return 'none';
  return top.name === PROJECT_PAGE_ROUTE && top.pageId === pageId ? 'none' : 'push';
}

/** Return to project home (New session): pop a covering route, if any. */
export function returnHomeMove(top: string | null): 'pop-home' | 'none' {
  return top === null || top === PROJECT_HOME_ROUTE ? 'none' : 'pop-home';
}

/**
 * Android hardware back on a project route.
 * - drawer open → `close-drawer`
 * - a sub-page on top → `pop` one level, to the page it was opened from
 * - a covering route on top → `pop-home`
 * - project home → `home` (never pop below the project; see ProjectScreen)
 */
export function androidBackMove(
  top: string | null,
  drawerOpen: boolean
): 'close-drawer' | 'pop' | 'pop-home' | 'home' {
  if (drawerOpen) return 'close-drawer';
  if (top === PROJECT_PAGE_ROUTE) return 'pop';
  return returnHomeMove(top) === 'pop-home' ? 'pop-home' : 'home';
}

/**
 * Back from a sub-page (its Go back, Android back). `stack` is the project
 * stack's route names, the sub-page last.
 * - a screen under it → `pop` to it
 * - nothing under it (a deep link straight to the sub-page) → `replace-home`:
 *   back never leaves the project
 */
export function subPageBackMove(stack: readonly string[]): 'pop' | 'replace-home' {
  return stack.length > 1 ? 'pop' : 'replace-home';
}

/**
 * The store left the home state (a drawer session row, the Review row, a
 * notification) while a sub-page is on top. The stack ends as
 * `[index, view]`:
 * - a view under the sub-pages → `pop-to-view`: that view swaps its content.
 *   Never replace a view with a new view: the old view's cleanup would close
 *   the session that just opened.
 * - otherwise → `reset-to-view`: the covering route and the sub-pages go, a
 *   new view mounts with the store already off home.
 */
export function subPageLeaveMove(stack: readonly string[]): 'pop-to-view' | 'reset-to-view' {
  return stack.includes(PROJECT_VIEW_ROUTE) ? 'pop-to-view' : 'reset-to-view';
}

/**
 * The reset state `[index, route]` for the project stack (a `reset` or
 * `reset-to-view` move). `bottom` is the stack's current first route: when it
 * is project home, its key is kept, so home stays mounted; otherwise (a deep
 * link) a new home is created.
 */
export function homeAndRoute(
  bottom: { key: string; name: string; params?: object } | undefined,
  route: { name: string; params?: object }
): { index: 1; routes: { key?: string; name: string; params?: object }[] } {
  const home =
    bottom?.name === PROJECT_HOME_ROUTE
      ? { key: bottom.key, name: bottom.name, params: bottom.params }
      : { name: PROJECT_HOME_ROUTE };
  return { index: 1, routes: [home, route] };
}

/**
 * What the left edge does on the focused project route. On a pushed sub-page
 * it goes back (iOS swipe-back; the page shows Go back, not the hamburger).
 * Everywhere else it opens the drawer. One edge, one meaning per screen.
 */
export function projectEdgeGesture(top: string | null): 'drawer' | 'back' {
  return top === PROJECT_PAGE_ROUTE ? 'back' : 'drawer';
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
 * the view's render: a tool page covers everything, then a thread (its
 * project session id), then a connecting session.
 */
export function shownProjectSessionId(state: {
  activePageId: string | null;
  /** The open thread's project session id (not the OpenCode id). */
  threadSessionId: string | null;
  connectingSessionId: string | null;
}): string | null {
  if (state.activePageId) return null;
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

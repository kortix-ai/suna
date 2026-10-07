/**
 * project-stack — route names and navigation decisions for the stack inside
 * `/projects/[id]` (components/session/ProjectRoutes, ProjectScreen).
 *
 * The stack is `[index]`, `[index, X]`, or `[index, X, page, …]`: X is a
 * covering route (view, sessions, files, account), and `page` is a sub-page
 * pushed from the page under it (Settings → project Settings → Schedules, or
 * the thread → Files from the session ··· sheet). A drawer destination
 * replaces a covering route instead of pushing over it, and drops any
 * sub-pages, so the drawer never deepens the stack. Only a sub-page open
 * deepens it, and back pops exactly one level.
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
 * Customize rows, Schedules, Secrets and Members; and the project's Files,
 * from the session ··· sheet over the thread (KRTX-1636). Tab-store page ids.
 */
export const SUB_PAGE_IDS = [
  'page:settings',
  'page:schedules',
  'page:secrets-nav',
  'page:members',
  'page:files-nav',
] as const;
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
 * What the store has open, as one comparable value: null on project home,
 * else the open page, thread, or connecting session. A sub-page records it
 * when it mounts (`subPageShouldLeave`).
 */
export function projectViewKey(input: {
  isHome: boolean;
  activePageId: string | null;
  activeSessionId: string | null;
  connectingSessionId: string | null;
}): string | null {
  if (input.isHome) return null;
  if (input.activePageId) return `page:${input.activePageId}`;
  if (input.activeSessionId) return `session:${input.activeSessionId}`;
  return `connecting:${input.connectingSessionId ?? ''}`;
}

/**
 * A focused sub-page leaves for the view when the store's open target
 * (`projectViewKey`) changed after the sub-page was pushed:
 * - pushed from home (Settings from Account), the store leaves home → leave
 * - pushed over a thread (Files), the same thread still open → stay
 * - pushed over a thread, another session opens (a notification) → leave;
 *   the view under it swaps its content
 * - pushed over a thread, the store returns home (the session was deleted) →
 *   leave; the view then removes itself and the stack ends on home
 */
export function subPageShouldLeave(input: {
  viewKey: string | null;
  viewKeyAtMount: string | null;
}): boolean {
  return input.viewKey !== input.viewKeyAtMount;
}

/**
 * The store's open target changed (a drawer session row, the Review row, a
 * notification) while a sub-page is on top (`subPageShouldLeave`). The stack ends as
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
  /** The open thread's project session id (not the runtime session id). */
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

/**
 * A drawer row that targets one runtime session of a project session: a
 * session row (its root pin) or a sub-session row under it (the child's id).
 *
 * - `open`: another project session — the connect path (`handleOpenProjectSession`).
 * - `focus`: the shown thread, another runtime session of it — only the tab
 *   store's active id changes (`navigateToSession`), the same sandbox stays,
 *   no reconnect. The task tool's View uses the same call.
 * - `queue`: the shown session is still connecting (no thread yet) — the
 *   target is remembered and the thread opens on it once connected.
 * - `close`: already on screen, or no target (no pin yet) — only the drawer
 *   closes.
 *
 * A sub-session row of a session NOT on screen is `open`: the caller opens
 * that session with the sub-session as its focus (`handleOpenProjectSession`).
 */
export function drawerThreadMove(state: {
  rowSessionId: string;
  targetRuntimeId: string | null;
  shownSessionId: string | null;
  /** The thread's runtime session id (tab store `activeSessionId`); null while connecting. */
  activeRuntimeId: string | null;
}): 'open' | 'focus' | 'queue' | 'close' {
  if (drawerSessionRowMove(state.rowSessionId, state.shownSessionId) === 'open') return 'open';
  if (!state.targetRuntimeId) return 'close';
  if (!state.activeRuntimeId) return 'queue';
  return state.targetRuntimeId !== state.activeRuntimeId ? 'focus' : 'close';
}

/** A runtime session to show once a project session's thread connects. */
export interface PendingThreadFocus {
  sessionId: string;
  runtimeId: string;
}

/**
 * Which runtime session a just-connected thread shows: the pending focus
 * when it belongs to this project session (a sub-session row tapped while
 * its parent was not open, or while it was connecting), else the root.
 */
export function threadOpenTarget(
  pending: PendingThreadFocus | null,
  sessionId: string,
  rootRuntimeId: string
): string {
  return pending?.sessionId === sessionId ? pending.runtimeId : rootRuntimeId;
}

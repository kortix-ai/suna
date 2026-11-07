/**
 * The host's URL for every page the components link to or navigate to.
 * Module-level, like `setUiHostEnv`: plain functions (review deep links, the
 * new-session flow) build these URLs outside React. A host whose router serves
 * another URL scheme calls `setUiRoutes` once at module load.
 *
 * A route that returns null is a page the host does not serve: every link to
 * it is hidden and no navigation goes there. `project` and `session` are the
 * two pages every session host serves, so they cannot be null. `channel` and
 * `dm` cannot be null either: the sidebar links them only while the project's
 * `chat` flag is on.
 *
 * Defaults: apps/web's paths.
 */
export interface UiRoutes {
  /** The project home: the new-session composer. */
  project: (projectId: string) => string;
  session: (projectId: string, sessionId: string) => string;
  /** The full session list, optionally on its archived or deleted view. */
  sessions: (projectId: string, view?: 'archived' | 'deleted') => string | null;
  /** The project's files, optionally with the proposed-changes panel open. */
  files: (projectId: string, panel?: 'proposed-changes') => string | null;
  drive: (projectId: string) => string | null;
  apps: (projectId: string) => string | null;
  /** @deprecated Rooms were removed (2026-11); ignored. Removed in the next major. */
  rooms?: (projectId: string) => string | null;
  /** The project's goals (flag `goals`); a goal is `<goals>/<scope>/<slug>`. */
  goals: (projectId: string) => string | null;
  /** The project's artifacts (flag `artifacts`); one is `<artifacts>/<artifact_id>`. */
  artifacts: (projectId: string) => string | null;
  /** One space: a channel and its tabs (`?tab=` opens one). */
  space: (projectId: string, slug: string) => string | null;
  members: (projectId: string) => string | null;
  /** The project settings page, on its sandbox section. */
  sandboxSettings: (projectId: string) => string | null;
  /**
   * The capability pages: agents, skills, connectors, triggers, reminders,
   * models, secrets, review, settings. `path` is the part after the
   * capability root, for example `models` or `triggers?id=<slug>`.
   */
  customize: (projectId: string, path?: string) => string | null;
  /**
   * Project admin: the project-wide libraries (connectors, skills, triggers,
   * loops, models, secrets, apps, repo) and settings, one section each.
   * `path` is the section and anything below it (`connectors/<app>`).
   */
  admin: (projectId: string, path?: string) => string | null;
  /** A channel of the project, by slug (`chat` flag). */
  channel: (projectId: string, slug: string) => string;
  /** The caller's direct messages with one agent, by agent name (`chat` flag). */
  dm: (projectId: string, agentName: string) => string;
  /** The project's Company memory (`chat` flag); a page is `?page=<page_id>`. */
  memory: (projectId: string) => string | null;
  /**
   * Review: everything that waits on a person (asks, approvals, changes), as
   * its own page beside the app sidebar. Absent: the host serves Review only
   * inside its `customize` route.
   */
  review?: (projectId: string) => string | null;
  /**
   * The Inbox: the signed-in person's notifications from every project, as a
   * page beside the project sidebar (KRTX-1742). Absent or null: the host
   * serves no Inbox page and the sidebar has no Inbox row. It is new
   * (2026-11-06), so a host that maps any route (its own router) gets no
   * Inbox row until it routes `inbox` too: no host gets a link it does not serve.
   */
  inbox?: (projectId: string) => string | null;
}

const DEFAULT_ROUTES = {
  project: (p: string) => `/workspaces/${p}`,
  session: (p: string, s: string) => `/workspaces/${p}/sessions/${s}`,
  sessions: (p: string, view?: 'archived' | 'deleted') => `/workspaces/${p}/sessions${view ? `?view=${view}` : ''}`,
  files: (p: string, panel?: 'proposed-changes') => `/workspaces/${p}/files${panel ? `?panel=${panel}` : ''}`,
  drive: (p: string) => `/workspaces/${p}/drive`,
  apps: (p: string) => `/workspaces/${p}/apps`,
  goals: (p: string) => `/workspaces/${p}/goals`,
  artifacts: (p: string) => `/workspaces/${p}/artifacts`,
  space: (p: string, slug: string) => `/workspaces/${p}/spaces/${encodeURIComponent(slug)}`,
  members: (p: string) => `/workspaces/${p}/members`,
  sandboxSettings: (p: string) => `/workspaces/${p}/admin/sandbox`,
  customize: (p: string, path?: string) => `/workspaces/${p}/customize${path ? `/${path}` : ''}`,
  admin: (p: string, path?: string) => `/workspaces/${p}/admin${path ? `/${path}` : ''}`,
  channel: (p: string, slug: string) => `/workspaces/${p}/c/${slug}`,
  dm: (p: string, agentName: string) => `/workspaces/${p}/dm/${encodeURIComponent(agentName)}`,
  memory: (p: string) => `/workspaces/${p}/memory`,
  review: (p: string) => `/workspaces/${p}/review`,
  inbox: (p: string) => `/workspaces/${p}/inbox`,
};

export const defaultUiRoutes: UiRoutes = DEFAULT_ROUTES;

let routes: UiRoutes = DEFAULT_ROUTES;

/**
 * Replaces the routes the host passes. Omitted routes keep their default,
 * except `admin`: a host that maps `customize` (to its own pages, or to null)
 * and says nothing of `admin` gets the same mapping for it, since the
 * libraries left Customize for Project admin (2026-10-27).
 */
export function setUiRoutes(overrides: Partial<UiRoutes>): void {
  const admin = overrides.admin ?? overrides.customize;
  // A host that routes its own customize pages serves Review there unless it also routes `review`.
  const review = overrides.review ?? (overrides.customize ? undefined : DEFAULT_ROUTES.review);
  // The Inbox page is new: only the default router (no override) serves it unasked.
  const inbox = overrides.inbox ?? (Object.keys(overrides).length === 0 ? DEFAULT_ROUTES.inbox : undefined);
  routes = { ...DEFAULT_ROUTES, ...overrides, ...(admin ? { admin } : {}), review, inbox };
}

export function uiRoutes(): UiRoutes {
  return routes;
}

/**
 * The query that asks the project home for its new-session composer. With the
 * `chat` flag on, the bare project home opens the default channel instead.
 */
const NEW_SESSION_PARAM = 'new';

/** The project home's new-session composer (sidebar Sessions `+`, Cmd+J, "New session"), not the default channel. */
export function newSessionHref(projectId: string): string {
  const home = routes.project(projectId);
  return `${home}${home.includes('?') ? '&' : '?'}${NEW_SESSION_PARAM}=1`;
}

/** True when the project home was opened with `newSessionHref`. */
export function isNewSessionRequested(params: Pick<URLSearchParams, 'get'> | null | undefined): boolean {
  return params?.get(NEW_SESSION_PARAM) === '1';
}

/** A channel slug or DM agent name from its URL segment; null when a hand-typed escape is malformed. */
export function decodeSpaceSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * A capability page's URL for the customize pages themselves: they are mounted
 * only by a host that serves them, so a null `customize` route falls back to
 * the default path instead of breaking their own tabs.
 */
export function customizePath(projectId: string, path?: string): string {
  return routes.customize(projectId, path) ?? DEFAULT_ROUTES.customize(projectId, path);
}

/** A Project admin URL, with the same fallback as `customizePath`. */
export function adminPath(projectId: string, path?: string): string {
  return routes.admin(projectId, path) ?? DEFAULT_ROUTES.admin(projectId, path);
}

/**
 * The session id `pathname` shows, read through the host's `session` route
 * (so a host URL scheme works), or null when it is not a session page of
 * `projectId`.
 */
export function sessionIdFromPath(pathname: string | null | undefined, projectId: string): string | null {
  if (!pathname) return null;
  const MARK = '\u0001';
  const [prefix, suffix = ''] = routes.session(projectId, MARK).split(MARK);
  if (!prefix || !pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const id = rest.split(/[/?#]/)[0];
  if (!id || (suffix && !rest.slice(id.length).startsWith(suffix))) return null;
  return decodeURIComponent(id);
}

/** True when `pathname` is the project's page or a page under it, per the host's `project` route. */
export function isProjectPath(pathname: string | null | undefined, projectId: string): boolean {
  if (!pathname) return false;
  const root = routes.project(projectId).replace(/\/$/, '');
  return pathname === root || pathname.startsWith(`${root}/`) || pathname.startsWith(`${root}?`);
}

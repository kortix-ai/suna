/**
 * The host's URL for every page the components link to or navigate to.
 * Module-level, like `setUiHostEnv`: plain functions (review deep links, the
 * new-session flow) build these URLs outside React. A host whose router serves
 * another URL scheme calls `setUiRoutes` once at module load.
 *
 * A route that returns null is a page the host does not serve: every link to
 * it is hidden and no navigation goes there. `project` and `session` are the
 * two pages every session host serves, so they cannot be null.
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
  members: (projectId: string) => string | null;
  /** The project settings page, on its sandbox section. */
  sandboxSettings: (projectId: string) => string | null;
  /**
   * The capability pages: agents, skills, connectors, triggers, reminders,
   * models, secrets, review, settings. `path` is the part after the
   * capability root, for example `models` or `triggers?id=<slug>`.
   */
  customize: (projectId: string, path?: string) => string | null;
}

const DEFAULT_ROUTES = {
  project: (p: string) => `/projects/${p}`,
  session: (p: string, s: string) => `/projects/${p}/sessions/${s}`,
  sessions: (p: string, view?: 'archived' | 'deleted') => `/projects/${p}/sessions${view ? `?view=${view}` : ''}`,
  files: (p: string, panel?: 'proposed-changes') => `/projects/${p}/files${panel ? `?panel=${panel}` : ''}`,
  drive: (p: string) => `/projects/${p}/drive`,
  apps: (p: string) => `/projects/${p}/apps`,
  members: (p: string) => `/projects/${p}/members`,
  sandboxSettings: (p: string) => `/projects/${p}/config?section=sandbox`,
  customize: (p: string, path?: string) => `/projects/${p}/customize${path ? `/${path}` : ''}`,
};

export const defaultUiRoutes: UiRoutes = DEFAULT_ROUTES;

let routes: UiRoutes = DEFAULT_ROUTES;

/** Replaces the routes the host passes. Omitted routes keep their default. */
export function setUiRoutes(overrides: Partial<UiRoutes>): void {
  routes = { ...DEFAULT_ROUTES, ...overrides };
}

export function uiRoutes(): UiRoutes {
  return routes;
}

/**
 * A capability page's URL for the customize pages themselves: they are mounted
 * only by a host that serves them, so a null `customize` route falls back to
 * the default path instead of breaking their own tabs.
 */
export function customizePath(projectId: string, path?: string): string {
  return routes.customize(projectId, path) ?? DEFAULT_ROUTES.customize(projectId, path);
}

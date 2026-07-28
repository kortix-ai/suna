/**
 * Where an authenticated user lands by default.
 *
 * The product is a project, not a list of projects. Every default entry point
 * (post-auth redirect, `/`, the desktop shell) resolves to a project page. The
 * `/projects` list stays reachable, but only when the user asks for it.
 *
 * `PROJECT_LANDING_PATH` is the id-free door used when we do not yet know which
 * project to open. It paints instantly and resolves the real project behind the
 * UI, so no caller ever has to block on a backend round-trip to build a
 * redirect. See `app/(app)/projects/start/page.tsx`.
 */
export const PROJECT_LANDING_PATH = '/projects/start';

/** Non-httpOnly so middleware can read it and the project page can set it. */
export const LAST_PROJECT_COOKIE = 'kortix_last_project';

/** One year. The value is a project id, not a credential. */
export const LAST_PROJECT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cookie is written by the browser, so treat it as untrusted input. Only a
 * well-formed UUID is ever interpolated into a redirect path — that keeps a
 * tampered cookie from turning the `/` redirect into an open redirect or a
 * path-traversal. A cookie naming a project the user cannot read still fails
 * closed: the project page 404s and bounces back to `PROJECT_LANDING_PATH`.
 */
export function isValidProjectId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** `/projects/<id>` for a trusted-shaped id, else null. */
export function projectPathFromId(projectId: string | null | undefined): string | null {
  return isValidProjectId(projectId) ? `/projects/${projectId}` : null;
}

/**
 * The default destination for an authenticated user, given whatever the browser
 * remembered. Falls back to the instant landing door, never to the list.
 */
export function resolveDefaultLandingPath(lastProjectId: string | null | undefined): string {
  return projectPathFromId(lastProjectId) ?? PROJECT_LANDING_PATH;
}

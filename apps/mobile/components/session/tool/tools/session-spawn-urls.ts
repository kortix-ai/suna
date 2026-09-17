/**
 * Ported unchanged from apps/web `tool/tools/session-spawn-urls.ts`.
 *
 * Web links a spawned worker to `/projects/:id/sessions/:sid?oc=<child>`.
 * Mobile has no URL routes inside a project: `SessionSpawnTool` opens the
 * child session with `useToolNavigation().openSession`, the tab store's
 * `navigateToSession`. The href builder is kept for share/deep-link callers
 * that need the web address of a child session.
 */
export function projectChildSessionHref(pathname: string | null, childSessionId: string | undefined) {
  if (!pathname || !childSessionId) return null;
  const match = pathname.match(/^\/projects\/([^/]+)\/sessions\/([^/?#]+)/);
  if (!match) return null;
  return `/projects/${match[1]}/sessions/${match[2]}?oc=${encodeURIComponent(childSessionId)}`;
}

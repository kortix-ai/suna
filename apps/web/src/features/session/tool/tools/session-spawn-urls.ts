export function workspaceChildSessionHref(
  pathname: string | null,
  childSessionId: string | undefined,
) {
  if (!pathname || !childSessionId) return null;
  const match = pathname.match(/^\/(?:workspaces|projects)\/([^/]+)\/sessions\/([^/?#]+)/);
  if (!match) return null;
  return `/workspaces/${match[1]}/sessions/${match[2]}?oc=${encodeURIComponent(childSessionId)}`;
}

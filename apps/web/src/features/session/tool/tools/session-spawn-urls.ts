export function projectChildSessionHref(
  pathname: string | null,
  childSessionId: string | undefined,
) {
  if (!pathname || !childSessionId) return null;
  const match = pathname.match(/^\/projects\/([^/]+)\/sessions\/([^/?#]+)/);
  if (!match) return null;
  return `/projects/${match[1]}/sessions/${match[2]}?oc=${encodeURIComponent(childSessionId)}`;
}

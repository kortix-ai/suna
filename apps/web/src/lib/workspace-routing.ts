const LEGACY_PROJECT_PREFIX = '/projects';
const WORKSPACE_PREFIX = '/workspaces';

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Convert a Project compatibility URL to the canonical Workspace URL. */
export function canonicalWorkspacePath(pathname: string): string | null {
  if (!hasPrefix(pathname, LEGACY_PROJECT_PREFIX)) return null;
  return `${WORKSPACE_PREFIX}${pathname.slice(LEGACY_PROJECT_PREFIX.length)}`;
}

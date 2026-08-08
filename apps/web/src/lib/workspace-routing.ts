const PROJECT_PREFIX = '/projects';
const WORKSPACE_PREFIX = '/workspaces';

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Convert a Project compatibility URL to the canonical Workspace URL. */
export function canonicalWorkspacePath(pathname: string): string | null {
  if (!hasPrefix(pathname, PROJECT_PREFIX)) return null;
  return `${WORKSPACE_PREFIX}${pathname.slice(PROJECT_PREFIX.length)}`;
}

/** Resolve a canonical Workspace URL onto the current Project route tree. */
export function workspaceCompatibilityPath(pathname: string): string | null {
  if (!hasPrefix(pathname, WORKSPACE_PREFIX)) return null;
  return `${PROJECT_PREFIX}${pathname.slice(WORKSPACE_PREFIX.length)}`;
}

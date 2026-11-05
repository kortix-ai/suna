/**
 * Workspace route templates: the names a route had before the Workspaces
 * unification, mapped to the names it has now.
 *
 * Every workspace route names its id `:workspaceId` since 2026-11-05 (the
 * route-param codemod, `scripts/codemods/workspace-route-params.ts`). Audit rows
 * and logs written before that name `:projectId` / `:accountId`.
 */

/** `:projectId` / `:accountId` in a route template → `:workspaceId`. Other params stay. */
export function renameWorkspaceRouteParams(template: string): string {
  return template.replace(/:(projectId|accountId)(?![A-Za-z0-9_])/g, ':workspaceId');
}

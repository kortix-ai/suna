/**
 * Legacy `kortix projects` command adapter.
 *
 * The canonical implementation lives in `workspaces.ts` and uses only the
 * Workspace SDK and API namespaces. Keep these aliases for installed scripts.
 */
import type { ProjectSummary, WorkspaceSummary } from '../api/types.ts';
import { projectWebUrl } from '../web-url.ts';
import {
  configureClonedWorkspaceAuth,
  currentGitCredentialHelperCommand,
  resolveWorkspaceCloneTarget,
  runWorkspaceDomain,
  saveClonedWorkspaceLink,
  type WorkspaceDomain,
  type WorkspaceCloneTarget,
} from './workspaces.ts';

export { currentGitCredentialHelperCommand };
export const configureClonedProjectAuth = configureClonedWorkspaceAuth;
export type ProjectCloneTarget = WorkspaceCloneTarget;

function asWorkspace(project: ProjectSummary): WorkspaceSummary {
  const { project_id, ...rest } = project;
  return { ...rest, workspace_id: project.workspace_id ?? project_id };
}

function asProject(workspace: WorkspaceSummary): ProjectSummary {
  const { workspace_id, ...rest } = workspace;
  return { ...rest, project_id: workspace_id };
}

/**
 * The legacy namespace is isolated here. Canonical command logic remains
 * Workspace-only while installed scripts retain Project routes and wire data.
 */
const PROJECT_DOMAIN: WorkspaceDomain = {
  command: 'projects',
  route: '/projects',
  singular: 'project',
  plural: 'projects',
  title: 'Project',
  normalize: (value) => asWorkspace(value as ProjectSummary),
  toWire: asProject,
  webUrl: projectWebUrl,
};

export function resolveProjectCloneTarget(
  project: ProjectSummary,
  kortixToken: string,
): ProjectCloneTarget {
  return resolveWorkspaceCloneTarget(asWorkspace(project), kortixToken);
}

export function saveClonedProjectLink(
  repoRoot: string,
  project: ProjectSummary,
  host: string | undefined,
  hostUrl: string,
): void {
  saveClonedWorkspaceLink(repoRoot, asWorkspace(project), host, hostUrl);
}

export async function runProjects(argv: string[]): Promise<number> {
  return runWorkspaceDomain(argv, PROJECT_DOMAIN);
}

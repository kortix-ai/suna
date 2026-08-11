/** Legacy Project compatibility adapter. */
export {
  configureWorkspaceGitAuth as configureProjectGitAuth,
  currentGitCredentialHelperCommand,
  isGitProxyUrl,
  resolveWorkspaceGitTarget as resolveProjectGitTarget,
  workspaceIsManaged as projectIsManaged,
} from './workspace-git.ts';
export type {
  WorkspaceGitCredentialMode as ProjectGitCredentialMode,
  WorkspaceGitRef as ProjectGitRef,
  WorkspaceGitTarget as ProjectGitTarget,
} from './workspace-git.ts';

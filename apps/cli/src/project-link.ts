/**
 * Legacy Project compatibility adapter.
 *
 * Canonical CLI code imports `workspace-link.ts`. Keep this module only for
 * older consumers and tests that still use Project names.
 */
export {
  clearWorkspaceLink as clearLink,
  isKortixWorkspace as isKortixProject,
  linkFilePath,
  loadWorkspaceLink as loadLink,
  resolveWorkspaceId as resolveProjectId,
  saveWorkspaceLink as saveLink,
} from './workspace-link.ts';
export type {
  WorkspaceLink as ProjectLink,
  WorkspaceLinkInput as ProjectLinkInput,
} from './workspace-link.ts';

/** Canonical Workspace aliases over the current Project-backed React layer. */
export {
  KortixProjectProvider as KortixWorkspaceProvider,
  useKortixRouteProjectId as useKortixRouteWorkspaceId,
} from './route-project';
export { clearProjectProviderCache as clearWorkspaceProviderCache } from './use-opencode-sessions';
export {
  mergeProjectSecretConnectedProviders as mergeWorkspaceSecretConnectedProviders,
  projectLlmCatalogToProviderList as workspaceLlmCatalogToProviderList,
} from './provider-selection';
export { refreshProjectProviderState as refreshWorkspaceProviderState } from './provider-refresh';
export {
  useAdminAccountProjects as useAdminAccountWorkspaces,
  type AdminAccountProject as AdminAccountWorkspace,
} from './use-admin-accounts';
export { useProjectConfig as useWorkspaceConfig } from './use-project-config';
export { useProjectModels as useWorkspaceModels } from './use-project-models';
export {
  useProjectSecrets as useWorkspaceSecrets,
  projectSecretsKey as workspaceSecretsKey,
} from './use-project-secrets';
export {
  useProjectTriggers as useWorkspaceTriggers,
  projectTriggersKey as workspaceTriggersKey,
} from './use-project-triggers';
export {
  projectConfigAgentsToOpenCodeAgents as workspaceConfigAgentsToOpenCodeAgents,
} from './use-opencode-sessions/agents';
export type { ProjectConfigSummary as WorkspaceConfigSummary } from '../core/rest/projects-client';

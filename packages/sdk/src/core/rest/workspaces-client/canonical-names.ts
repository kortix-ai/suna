/** Workspace-named exports for compatibility subpaths without generic clashes. */
export type {
  AccountDetail as WorkspaceAccountDetail,
  AccountMember as WorkspaceAccountMember,
} from './accounts';
export type {
  AccountToken as WorkspaceAccountToken,
  CreatedAccountToken as WorkspaceCreatedAccountToken,
} from './tokens';
export type {
  AdminConnector as WorkspaceAdminConnector,
  ConnectorAuthorizationStrategy as WorkspaceConnectorAuthorizationStrategy,
  ConnectorConfig as WorkspaceConnectorConfig,
  ConnectorDraftInput as WorkspaceConnectorDraftInput,
} from './connectors';
export type {
  App as WorkspaceApp,
  AppAccessConfig as WorkspaceAppAccessConfig,
  AppAccessMode as WorkspaceAppAccessMode,
} from './apps';
export type { AuditEvent as WorkspaceAuditEvent } from './audit';
export type { ChangeRequest as WorkspaceChangeRequest } from './change-requests';
export type { ConnectorSharing as WorkspaceConnectorSharing } from './shared';
export type {
  GatewayBudgetRow as WorkspaceGatewayBudgetRow,
  GatewayRoutingPolicyDocument as WorkspaceGatewayRoutingPolicyDocument,
} from './gateway';
export type {
  SessionAudit as WorkspaceSessionAudit,
  SessionPublicShare as WorkspaceSessionPublicShare,
} from './sessions';
export {
  archiveWorkspace,
  createWorkspace,
  createWorkspaceRepo,
  fetchWorkspacesForAccountWithToken,
  getWorkspace,
  getWorkspaceDetail,
  getWorkspaceGitToken,
  getWorkspaceLlmCatalog,
  getWorkspaceLlmCatalogProviders,
  getWorkspaceModelPicker,
  getWorkspaceSandboxProviderTransition,
  isManagedGithubWorkspace,
  listWorkspaces,
  listWorkspacesForAccount,
  provisionWorkspace,
  provisionWorkspaceStream,
  provisionWorkspaceWithToken,
  setWorkspaceOnboardingComplete,
  setWorkspaceOnboardingProfile,
  updateWorkspace,
  updateWorkspaceSandboxProvider,
  validateWorkspaceManifest,
  type CreateWorkspaceRepoInput,
  type KortixWorkspace,
  type ProvisionWorkspaceInput,
  type ProvisionWorkspaceWithTokenResult,
  type UpdateWorkspaceSandboxProviderResult,
  type WorkspaceConfigSummary,
  type WorkspaceDetail,
  type WorkspaceGitToken,
  type WorkspaceGlyph,
  type WorkspaceInput,
  type WorkspaceLlmCatalogProvider,
  type WorkspaceLlmCatalogProvidersResponse,
  type WorkspaceLlmCatalogResponse,
  type SandboxProviderTransitionState as WorkspaceSandboxProviderTransitionState,
  type SandboxProviderTransitionView as WorkspaceSandboxProviderTransitionView,
} from './workspaces';
export {
  approveWorkspaceAccessRequest,
  attachGroupToWorkspace,
  createWorkspaceResourceGrant,
  deleteWorkspaceResourceGrant,
  detachGroupFromWorkspace,
  inviteWorkspaceMember,
  listPendingWorkspaceInvites,
  listWorkspaceAccess,
  listWorkspaceAccessRequests,
  listWorkspaceGroupGrants,
  listWorkspaceResourceGrants,
  rejectWorkspaceAccessRequest,
  requestWorkspaceAccess,
  resendPendingWorkspaceInvite,
  revokePendingWorkspaceInvite,
  revokeWorkspaceAccess,
  updateWorkspaceAccess,
  updateWorkspaceGroupGrant,
  type InviteWorkspaceMemberResult,
  type PendingWorkspaceInvite,
  type RequestWorkspaceAccessResult,
  type ResendWorkspaceInviteResult,
  type WorkspaceAccessMember,
  type WorkspaceAccessRequest,
  type WorkspaceAccessResponse,
  type WorkspaceAgentResourceItem,
  type WorkspaceGroupAccessSource,
  type WorkspaceGroupGrant,
  type WorkspaceResourceGrant,
  type WorkspaceResourceGrantsResponse,
  type WorkspaceResourceItem,
} from './access';
export {
  brokerWorkspaceSecretRequest,
  deletePersonalWorkspaceSecret,
  deleteWorkspaceProviderOAuth,
  deleteWorkspaceSecret,
  listWorkspaceSecrets,
  pollWorkspaceProviderOAuth,
  setPersonalWorkspaceSecret,
  setWorkspaceSecretStrategy,
  startWorkspaceProviderOAuth,
  upsertWorkspaceGitCredential,
  upsertWorkspaceSecret,
  type WorkspaceSecret,
  type WorkspaceSecretsResponse,
} from './secrets';
export {
  ensureWorkspaceConnectorConnection,
  ensureWorkspaceConnectorProfile,
} from './connectors';
export {
  listWorkspacePolicies,
  setWorkspacePolicies,
  type WorkspacePoliciesResponse,
  type WorkspacePolicy,
} from './policies';
export {
  getWorkspaceSandboxHealth,
  listWorkspaceSandboxTemplates,
  listWorkspaceSandboxes,
  listWorkspaceSnapshots,
  rebuildWorkspaceSnapshot,
  type WorkspaceSandboxHealth,
  type WorkspaceSnapshotBuild,
  type WorkspaceSnapshotStatus,
  type WorkspaceSnapshotsResponse,
} from './sandbox';
export {
  fetchWorkspaceArchive,
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceFiles,
  type WorkspaceFileSearchMatch,
  type WorkspaceFileSearchResponse,
} from './files';
export {
  getWorkspaceCommit,
  getWorkspaceCommitDiff,
  getWorkspaceFileHistory,
  listWorkspaceBranches,
  listWorkspaceCommits,
  type WorkspaceBranch,
  type WorkspaceBranchesResponse,
  type WorkspaceCommit,
  type WorkspaceCommitDetail,
  type WorkspaceCommitDiffResponse,
  type WorkspaceCommitFile,
  type WorkspaceCommitsResponse,
  type WorkspaceFileHistoryResponse,
} from './git-history';
export {
  claimWarmWorkspaceSession,
  createWorkspaceSession,
  deleteWorkspaceSession,
  ensureWarmWorkspaceSession,
  getWorkspaceSession,
  getWorkspaceSessionConfigState,
  getWorkspaceSessionScope,
  listWorkspaceSessions,
  reloadWorkspaceSessionConfig,
  reloadWorkspaceSessionConfigStream,
  restartWorkspaceSession,
  setWorkspaceSessionModel,
  setWorkspaceSessionScope,
  setWorkspaceSessionSharing,
  stopWorkspaceSession,
  updateWorkspaceSession,
  type ClaimWarmWorkspaceSessionInput,
  type CreateWorkspaceSessionInput,
  type WarmWorkspaceSessionResult,
  type WarmWorkspaceSessionWorkspaceRefresh,
  type WorkspaceOpenCodeSession,
  type WorkspaceRuntimeSession,
  type WorkspaceSession,
  type WorkspaceSessionStatus,
} from './sessions';
export {
  createWorkspaceTrigger,
  deleteWorkspaceTrigger,
  fireWorkspaceTrigger,
  listWorkspaceTriggers,
  setWorkspaceTriggersActivation,
  updateWorkspaceTrigger,
  type CreateWorkspaceTriggerInput,
  type FireWorkspaceTriggerResponse,
  type UpdateWorkspaceTriggerInput,
  type WorkspaceTrigger,
  type WorkspaceTriggerListing,
  type WorkspaceTriggerParseError,
  type WorkspaceTriggerSessionMode,
  type WorkspaceTriggerType,
} from './triggers';
export {
  startWorkspaceSession,
  workspaceSessionStartSeed,
  type WorkspaceSessionSandbox,
  type WorkspaceSessionSandboxStatus,
} from './session-sandbox';
export { setWorkspaceModelEnablement } from './model-enablement';
export {
  updateWorkspaceDefaultAgent,
  type UpdateWorkspaceDefaultAgentResponse,
} from './agent-config';
export {
  listCostByWorkspace,
  type ListCostByWorkspaceOptions,
  type WorkspaceCostExportOptions,
  type WorkspaceCostPage,
  type WorkspaceCostRow,
  type WorkspaceCostSort,
} from './session-costs';
export type { GatewayWorkspaceRoutingPolicy } from './gateway';
export {
  listGroupWorkspaceGrants,
  listMemberWorkspaceAccess,
  type GroupWorkspaceGrant,
  type MemberWorkspaceAccess,
} from './iam';
export {
  createWorkspaceCliToken,
  listWorkspaceCliTokens,
  revokeWorkspaceCliToken,
  type CreatedWorkspaceCliToken,
  type WorkspaceCliToken,
  type WorkspaceCliTokenListResponse,
} from './tokens';
export { listWorkspaceAudit } from './audit';
export {
  requestWorkspaceConnector,
  requestWorkspaceSecret,
  type RequestWorkspaceConnectorInput,
  type RequestWorkspaceSecretInput,
} from './setup-links';
export type {
  WorkspaceFileEntry,
  WorkspaceGitConnection,
  WorkspaceRole,
} from './shared';

// Main exports
export { createDb, type Database } from './client';
export * as schema from './schema';

// Re-export frequently used schemas and types for convenience
export {
  // Schema namespace
  kortixSchema,
  // Enums
  sandboxStatusEnum,
  deploymentStatusEnum,
  deploymentSourceEnum,
  apiKeyStatusEnum,
  apiKeyTypeEnum,
  // Kortix tables — accounts
  accounts,
  accountMembers,
  accountRoleEnum,
  accountsRelations,
  accountMembersRelations,
  // Kortix tables
  sandboxes,
  sandboxMembers,
  sandboxMemberScopes,
  scopeEffectEnum,
  sandboxInvites,
  deployments,
  kortixApiKeys,
  integrationCredentials,
  integrations,
  sandboxIntegrations,
  serverEntries,
  // Enums (integrations)
  integrationStatusEnum,
  // Relations
  sandboxesRelations,
  sandboxMembersRelations,
  sandboxInvitesRelations,
  deploymentsRelations,
  kortixApiKeysRelations,
  integrationsRelations,
  sandboxIntegrationsRelations,
  // Billing / Credits (moved from public → kortix schema)
  billingCustomers,
  creditAccounts,
  creditLedger,
  creditUsage,
  accountDeletionRequests,
  creditPurchases,
  // Tunnel
  tunnelStatusEnum,
  tunnelCapabilityEnum,
  tunnelPermissionStatusEnum,
  tunnelPermissionRequestStatusEnum,
  tunnelConnections,
  tunnelPermissions,
  tunnelPermissionRequests,
  tunnelAuditLogs,
  tunnelDeviceAuthStatusEnum,
  tunnelDeviceAuthRequests,
  tunnelConnectionsRelations,
  tunnelPermissionsRelations,
  tunnelPermissionRequestsRelations,
  tunnelAuditLogsRelations,
  // OAuth2 Provider
  oauthClients,
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  // Platform User Roles
  platformRoleEnum,
  platformUserRoles,
  // Access Control
  accessRequestStatusEnum,
  platformSettings,
  accessAllowlist,
  accessRequests,
  // Pool
  poolResources,
  poolSandboxes,
} from './schema/kortix';

export type {
  TunnelMachineInfo,
  TunnelFilesystemScope,
  TunnelShellScope,
  TunnelNetworkScope,
  TunnelPermissionScope,
} from './schema/kortix';

// Public/basejump tables
export {
  apiKeys,
  accountUser,
  billingCustomersInBasejump,
} from './schema/public';

export type {
  Account,
  AccountMember,
  NewAccount,
  NewAccountMember,
  Sandbox,
  NewSandbox,
  ApiKey,
  CreditAccount,
  AccountUser,
  NewApiKey,
  SandboxSelect,
  KortixApiKey,
  NewKortixApiKey,
  IntegrationCredential,
  NewIntegrationCredential,
  Integration,
  NewIntegration,
  SandboxIntegration,
  NewSandboxIntegration,
  ServerEntry,
  NewServerEntry,
  TunnelConnection,
  NewTunnelConnection,
  TunnelPermission,
  NewTunnelPermission,
  TunnelPermissionRequest,
  NewTunnelPermissionRequest,
  TunnelAuditLog,
  NewTunnelAuditLog,
} from './types';

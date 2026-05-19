import { sandboxes, deployments, kortixApiKeys, serverEntries, accounts, accountMembers, accountInvitations, accountGithubInstallations, auditEvents, usageEvents, projects, projectMembers, projectSecrets, projectTriggers, projectTriggerEvents, projectSessions, projectRuntimeSnapshots, sessionSandboxes, legacySandboxMigrations, creditAccounts, tunnelConnections, tunnelPermissions, tunnelPermissionRequests, tunnelAuditLogs, chatChannelBindings, chatThreads } from './schema/kortix';
import { apiKeys, accountUser } from './schema/public';

// Select types (what you get back from queries)
export type Account = typeof accounts.$inferSelect;
export type AccountMember = typeof accountMembers.$inferSelect;
export type AccountInvitation = typeof accountInvitations.$inferSelect;
export type AccountGithubInstallation = typeof accountGithubInstallations.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type NewAccountMember = typeof accountMembers.$inferInsert;
export type NewAccountInvitation = typeof accountInvitations.$inferInsert;
export type NewAccountGithubInstallation = typeof accountGithubInstallations.$inferInsert;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
export type ProjectSecret = typeof projectSecrets.$inferSelect;
export type NewProjectSecret = typeof projectSecrets.$inferInsert;
export type ProjectTrigger = typeof projectTriggers.$inferSelect;
export type NewProjectTrigger = typeof projectTriggers.$inferInsert;
export type ProjectTriggerEvent = typeof projectTriggerEvents.$inferSelect;
export type NewProjectTriggerEvent = typeof projectTriggerEvents.$inferInsert;
export type ProjectSession = typeof projectSessions.$inferSelect;
export type NewProjectSession = typeof projectSessions.$inferInsert;
export type ProjectRuntimeSnapshot = typeof projectRuntimeSnapshots.$inferSelect;
export type NewProjectRuntimeSnapshot = typeof projectRuntimeSnapshots.$inferInsert;
export type SessionSandbox = typeof sessionSandboxes.$inferSelect;
export type NewSessionSandbox = typeof sessionSandboxes.$inferInsert;
export type LegacySandboxMigration = typeof legacySandboxMigrations.$inferSelect;
export type NewLegacySandboxMigration = typeof legacySandboxMigrations.$inferInsert;
export type Sandbox = typeof sandboxes.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type CreditAccount = typeof creditAccounts.$inferSelect;
/** @deprecated Use AccountMember instead — basejump.account_user is being migrated to kortix.account_members */
export type AccountUser = typeof accountUser.$inferSelect;
export type KortixApiKey = typeof kortixApiKeys.$inferSelect;

// Insert types (what you pass to inserts)
export type NewSandbox = typeof sandboxes.$inferInsert;
export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type NewKortixApiKey = typeof kortixApiKeys.$inferInsert;
export type ServerEntry = typeof serverEntries.$inferSelect;
export type NewServerEntry = typeof serverEntries.$inferInsert;

// Chat / channels
export type ChatChannelBinding = typeof chatChannelBindings.$inferSelect;
export type NewChatChannelBinding = typeof chatChannelBindings.$inferInsert;
export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;

// Tunnel
export type TunnelConnection = typeof tunnelConnections.$inferSelect;
export type NewTunnelConnection = typeof tunnelConnections.$inferInsert;
export type TunnelPermission = typeof tunnelPermissions.$inferSelect;
export type NewTunnelPermission = typeof tunnelPermissions.$inferInsert;
export type TunnelPermissionRequest = typeof tunnelPermissionRequests.$inferSelect;
export type NewTunnelPermissionRequest = typeof tunnelPermissionRequests.$inferInsert;
export type TunnelAuditLog = typeof tunnelAuditLogs.$inferSelect;
export type NewTunnelAuditLog = typeof tunnelAuditLogs.$inferInsert;

// Aliases
export type SandboxSelect = Sandbox;
export type DeploymentSelect = Deployment;

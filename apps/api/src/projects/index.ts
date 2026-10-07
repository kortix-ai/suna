/**
 * Project CRUD.
 *
 * Project is the new first-class source-of-truth object: one account-owned Git
 * repo plus the Kortix metadata needed to render and launch sessions later.
 * The old sandbox/instance tables remain as legacy compute state.
 *
 * ─── Structural note ─────────────────────────────────────────────────────────
 * The wired Hono app and the shared helpers live in ./lib/*. The route
 * registrations live in ./routes/*, one file per domain (projects, secrets,
 * connections, triggers, channels, sessions, change requests, ...); each
 * exports a register<Name>Routes() function. This file calls them in route
 * order. The service surface that other domains use lives in ./surface.ts;
 * this file re-exports it.
 */

import { projectWebhooksApp, projectsApp } from './lib/app';
import { registerProjectsRoutes } from './routes/projects';
import { registerTriggerWebhooksRoutes } from './routes/trigger-webhooks';
import { registerProjectGitRoutes } from './routes/project-git';
import { registerGithubInstallationsRoutes } from './routes/github-installations';
import { registerGithubRepositoriesRoutes } from './routes/github-repositories';
import { registerGitBackendRoutes } from './routes/git-backend';
import { registerProjectFromRepositoryRoutes } from './routes/project-from-repository';
import { registerManifestValidationRoutes } from './routes/manifest-validation';
import { registerSandboxesRoutes } from './routes/sandboxes';
import { registerSandboxTemplatesRoutes } from './routes/sandbox-templates';
import { registerProjectCredentialsRoutes } from './routes/project-credentials';
import { registerSecretsRoutes } from './routes/secrets';
import { registerSecretDeliveryRoutes } from './routes/secret-delivery';
import { registerProviderOauthRoutes } from './routes/provider-oauth';
import { registerRepositoryReplacementRoutes } from './routes/repository-replacement';
import { registerSecretBrokerRoutes } from './routes/secret-broker';
import { registerSecretRelayRoutes } from './routes/secret-relay';
import { registerSetupLinksRoutes } from './routes/setup-links';
import { registerConnectionsRoutes } from './routes/connections';
import { registerConnectionActionsRoutes } from './routes/connection-actions';
import { registerComputersRoutes } from './routes/computers';
import { registerTriggersRoutes } from './routes/triggers';
import { registerChannelSlackRoutes } from './routes/channel-slack';
import { registerChannelTeamsRoutes } from './routes/channel-teams';
import { registerChannelEmailRoutes } from './routes/channel-email';
import { registerTurnStreamRoutes } from './routes/turn-stream';
import { registerModelsRoutes } from './routes/models';
import { registerTurnQuestionsRoutes } from './routes/turn-questions';
import { registerTurnPermissionsRoutes } from './routes/turn-permissions';
import { registerOauth2ConnectorsRoutes } from './routes/oauth2-connectors';
import { registerProjectDetailRoutes } from './routes/project-detail';
import { registerProjectFilesRoutes } from './routes/project-files';
import { registerProjectSettingsRoutes } from './routes/project-settings';
import { registerProjectAccessRoutes } from './routes/project-access';
import { registerAccessRequestsRoutes } from './routes/access-requests';
import { registerProjectInvitesRoutes } from './routes/project-invites';
import { registerGroupGrantsRoutes } from './routes/group-grants';
import { registerWarmSessionsRoutes } from './routes/warm-sessions';
import { registerProviderSecretPoolsRoutes } from './routes/provider-secret-pools';
import { registerProjectSessionsRoutes } from './routes/project-sessions';
import { registerSessionTranscriptsRoutes } from './routes/session-transcripts';
import { registerSessionAttachmentsRoutes } from './routes/session-attachments';
import { registerSessionOpenBundleRoutes } from './routes/session-open-bundle';
import { registerSessionStreamRoutes } from './routes/session-stream';
import { registerProjectAuditRoutes } from './routes/project-audit';
import { registerApprovalsRoutes } from './routes/approvals';
import { registerResourceGrantsRoutes } from './routes/resource-grants';
import { registerSessionScopeRoutes } from './routes/session-scope';
import { registerSessionConfigRoutes } from './routes/session-config';
import { registerConfigReleaseRoutes } from '../config-releases/routes';
import { registerPublicSharesRoutes } from './routes/public-shares';
import { registerSessionRuntimeRoutes } from './routes/session-runtime';
import { registerSessionPresenceRoutes } from './routes/session-presence';
import { registerSessionParticipantsRoutes } from './routes/session-participants';
import { registerSessionPromptsRoutes } from './routes/session-prompts';
import { registerSessionRemindersRoutes } from './routes/session-reminders';
import { registerChangeRequestsRoutes } from './routes/change-requests';
import { registerPromptAttachmentsRoutes } from './routes/prompt-attachments';
import { registerChangeRequestActionsRoutes } from './routes/change-request-actions';
import { registerMarketplaceInstallSessionRoutes } from './routes/marketplace-install-session';
import { registerReviewItemsRoutes } from './routes/review-items';
import { registerAgentScopeRoutes } from './routes/agent-scope';
import { registerAgentConfigRoutes } from './routes/agent-config';
import { registerProjectSkillsRoutes } from './routes/project-skills';
import { registerGatewayRoutes } from './routes/gateway';
import { registerChannelBindingsRoutes } from './routes/channel-bindings';
import { registerMonitorsRoutes } from './routes/monitors';
import { registerAppsRoutes } from '../apps/routes';

/**
 * Registers every project route on `projectsApp` / `projectWebhooksApp`.
 * app.ts calls it once, right before it mounts them. Never call it at import
 * time: a route module that reaches this file through an import cycle would
 * otherwise register before its own body ran.
 */
export function registerAllProjectRoutes(): void {
  // Hono dispatches in registration order, so the order of these calls IS the
  // route order. registerProjectsRoutes() registers the global `/*` auth
  // middleware first (its first statement), then the remaining route groups.
  registerProjectsRoutes();
  registerTriggerWebhooksRoutes();
  registerProjectGitRoutes();
  registerGithubInstallationsRoutes();
  registerGithubRepositoriesRoutes();
  registerGitBackendRoutes();
  registerProjectFromRepositoryRoutes();
  registerManifestValidationRoutes();
  registerSandboxesRoutes();
  registerSandboxTemplatesRoutes();
  registerProjectCredentialsRoutes();
  registerSecretsRoutes();
  registerSecretDeliveryRoutes();
  registerProviderOauthRoutes();
  registerRepositoryReplacementRoutes();
  registerSecretBrokerRoutes();
  registerSecretRelayRoutes();
  registerSetupLinksRoutes();
  registerConnectionsRoutes();
  registerConnectionActionsRoutes();
  registerComputersRoutes();
  registerTriggersRoutes();
  registerChannelSlackRoutes();
  registerChannelTeamsRoutes();
  registerChannelEmailRoutes();
  registerTurnStreamRoutes();
  registerModelsRoutes();
  registerTurnQuestionsRoutes();
  registerTurnPermissionsRoutes();
  registerOauth2ConnectorsRoutes();
  registerProjectDetailRoutes();
  registerProjectFilesRoutes();
  registerProjectSettingsRoutes();
  registerProjectAccessRoutes();
  registerAccessRequestsRoutes();
  registerProjectInvitesRoutes();
  registerGroupGrantsRoutes();
  registerWarmSessionsRoutes();
  registerProviderSecretPoolsRoutes();
  registerProjectSessionsRoutes();
  registerSessionTranscriptsRoutes();
  registerSessionAttachmentsRoutes();
  registerSessionOpenBundleRoutes();
  registerSessionStreamRoutes();
  registerProjectAuditRoutes();
  registerApprovalsRoutes();
  registerResourceGrantsRoutes();
  registerSessionScopeRoutes();
  registerSessionConfigRoutes();
  registerConfigReleaseRoutes();
  registerPublicSharesRoutes();
  registerSessionRuntimeRoutes();
  registerSessionPresenceRoutes();
  registerSessionParticipantsRoutes();
  registerSessionPromptsRoutes();
  registerSessionRemindersRoutes();
  registerChangeRequestsRoutes();
  registerPromptAttachmentsRoutes();
  registerChangeRequestActionsRoutes();
  registerMarketplaceInstallSessionRoutes();
  registerReviewItemsRoutes();
  registerAgentScopeRoutes();
  registerAgentConfigRoutes();
  registerProjectSkillsRoutes();
  registerGatewayRoutes();
  registerChannelBindingsRoutes();
  registerMonitorsRoutes();
  registerAppsRoutes();
}

// The Hono app instances. app.ts registers their routes and mounts them.
export { projectsApp, projectWebhooksApp };

// The service surface (git-proxy, session, trigger and manifest helpers).
export * from './surface';

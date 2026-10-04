/**
 * The /v1/projects HTTP surface.
 *
 * The route registrations live in this folder, one file per area (projects,
 * secrets, connections, triggers, channels, sessions, change requests, ...);
 * each exports a register<Name>Routes() function. registerAllProjectRoutes()
 * calls them in route order. The project service surface is
 * services/projects/index.ts.
 */

import { projectWebhooksApp, projectsApp } from './app';
import { registerProjectsRoutes } from './projects';
import { registerTriggerWebhooksRoutes } from './trigger-webhooks';
import { registerProjectGitRoutes } from './project-git';
import { registerGithubInstallationsRoutes } from './github-installations';
import { registerGithubRepositoriesRoutes } from './github-repositories';
import { registerGitBackendRoutes } from './git-backend';
import { registerProjectFromRepositoryRoutes } from './project-from-repository';
import { registerManifestValidationRoutes } from './manifest-validation';
import { registerSandboxesRoutes } from './sandboxes';
import { registerSandboxTemplatesRoutes } from './sandbox-templates';
import { registerProjectCredentialsRoutes } from './project-credentials';
import { registerSecretsRoutes } from './secrets';
import { registerSecretDeliveryRoutes } from './secret-delivery';
import { registerProviderOauthRoutes } from './provider-oauth';
import { registerRepositoryReplacementRoutes } from './repository-replacement';
import { registerSecretBrokerRoutes } from './secret-broker';
import { registerSecretRelayRoutes } from './secret-relay';
import { registerSetupLinksRoutes } from './setup-links';
import { registerConnectionsRoutes } from './connections';
import { registerConnectionActionsRoutes } from './connection-actions';
import { registerComputersRoutes } from './computers';
import { registerTriggersRoutes } from './triggers';
import { registerChannelSlackRoutes } from './channel-slack';
import { registerChannelTeamsRoutes } from './channel-teams';
import { registerChannelEmailRoutes } from './channel-email';
import { registerTurnStreamRoutes } from './turn-stream';
import { registerModelsRoutes } from './models';
import { registerTurnQuestionsRoutes } from './turn-questions';
import { registerTurnPermissionsRoutes } from './turn-permissions';
import { registerOauth2ConnectorsRoutes } from './oauth2-connectors';
import { registerProjectDetailRoutes } from './project-detail';
import { registerProjectFilesRoutes } from './project-files';
import { registerProjectSettingsRoutes } from './project-settings';
import { registerProjectAccessRoutes } from './project-access';
import { registerAccessRequestsRoutes } from './access-requests';
import { registerProjectInvitesRoutes } from './project-invites';
import { registerGroupGrantsRoutes } from './group-grants';
import { registerWarmSessionsRoutes } from './warm-sessions';
import { registerProviderSecretPoolsRoutes } from './provider-secret-pools';
import { registerProjectSessionsRoutes } from './project-sessions';
import { registerSessionEnvironmentRoutes } from './session-environment';
import { registerSessionTranscriptsRoutes } from './session-transcripts';
import { registerSessionAttachmentsRoutes } from './session-attachments';
import { registerSessionOpenBundleRoutes } from './session-open-bundle';
import { registerSessionStreamRoutes } from './session-stream';
import { registerProjectAuditRoutes } from './project-audit';
import { registerApprovalsRoutes } from './approvals';
import { registerResourceGrantsRoutes } from './resource-grants';
import { registerSessionScopeRoutes } from './session-scope';
import { registerSessionConfigRoutes } from './session-config';
import { registerConfigReleaseRoutes } from '../config-releases/routes';
import { registerPublicSharesRoutes } from './public-shares';
import { registerSessionRuntimeRoutes } from './session-runtime';
import { registerSessionPresenceRoutes } from './session-presence';
import { registerSessionParticipantsRoutes } from './session-participants';
import { registerSessionPromptsRoutes } from './session-prompts';
import { registerSessionRemindersRoutes } from './session-reminders';
import { registerChangeRequestsRoutes } from './change-requests';
import { registerPromptAttachmentsRoutes } from './prompt-attachments';
import { registerChangeRequestActionsRoutes } from './change-request-actions';
import { registerMarketplaceInstallSessionRoutes } from './marketplace-install-session';
import { registerReviewItemsRoutes } from './review-items';
import { registerAgentScopeRoutes } from './agent-scope';
import { registerAgentConfigRoutes } from './agent-config';
import { registerGatewayRoutes } from './gateway';
import { registerChannelBindingsRoutes } from './channel-bindings';
import { registerMonitorsRoutes } from './monitors';
import { registerAppsRoutes } from '../apps/routes';

/**
 * Registers every project route on `projectsApp` / `projectWebhooksApp`.
 * app.ts calls it once, before it mounts them. Called at the mount site, never at import time:
 * a route module that reaches this file through an import cycle would
 * otherwise be registered before its own body ran.
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
  registerSessionEnvironmentRoutes();
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
  registerGatewayRoutes();
  registerChannelBindingsRoutes();
  registerMonitorsRoutes();
  registerAppsRoutes();
}

// The Hono app instances. app.ts registers their routes and mounts them.
export { projectsApp, projectWebhooksApp };

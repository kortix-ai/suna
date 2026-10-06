/**
 * Projects data client — now backed by @kortix/sdk.
 *
 * This file used to hand-roll ~1560 lines re-implementing the same REST
 * surface the SDK now exposes (web-aligned, hits the same repo-first backend
 * endpoints: GET /accounts, GET /projects?account_id=, etc.). It's kept as a
 * single file so every existing mobile import path
 * (`@/lib/projects/projects-client`) keeps working unchanged — see the SDK
 * adoption report for the function-by-function mapping.
 *
 * Every function below is `@kortix/sdk`'s, re-exported or adapted to the
 * argument shape mobile's callers use. No call here builds its own request.
 */

import * as sdk from '@kortix/sdk';

// ── Accounts ─────────────────────────────────────────────────────────────────

export type { AccountRole, ProjectRole, ConnectorSharing } from '@kortix/sdk';
export type { KortixAccount } from '@kortix/sdk';

export { listAccounts } from '@kortix/sdk';

// ── Projects ───────────────────────────────────────────────────────────────

export type {
  KortixProject,
  ExperimentalFeatureKey,
  ExperimentalFeatureView,
  ProjectInput,
  RepoCollaboratorInvite,
} from '@kortix/sdk';

export {
  listProjectsForAccount,
  getProject,
  inviteRepoCollaborator,
  isManagedGithubProject,
  archiveProject,
  updateProject,
  updateExperimentalFeature,
} from '@kortix/sdk';

// ── Dev ───────────────────────────────────────────────────────────────────────
// inviteRepoCollaborator / isManagedGithubProject re-exported above.

// ── Project sessions (one branch + sandbox per row; web-aligned) ────────────

export type { ProjectSessionStatus, ProjectSession } from '@kortix/sdk';
/** The SDK's `createProjectSession` takes this as an inline (unnamed) type;
 *  derive the name mobile used to export rather than duplicating the shape. */
export type CreateProjectSessionInput = NonNullable<Parameters<typeof sdk.createProjectSession>[1]>;
/** Mobile's own name for the SDK's `ConnectorSharing` reused on sessions. */
export type { ConnectorSharing as SessionSharing } from '@kortix/sdk';

export {
  listProjectSessions,
  listProjectSessionsPage,
  createProjectSession,
  restartProjectSession,
  updateProjectSession,
  deleteProjectSession,
  setProjectSessionSharing,
  stopProjectSession,
} from '@kortix/sdk';

// ── Session participants and message authors ───────────────────────────────

export type { SessionMessageAuthor, SessionMessageAuthors, SessionParticipant, SessionParticipants } from '@kortix/sdk';
export { getSessionMessageAuthors, getSessionParticipants } from '@kortix/sdk';

// ── Session public shares (KRTX-248: the public transcript link) ────────────
// `createSessionPublicShare(pid, sid, { transcript: true })` returns the live
// transcript share when one exists (200) or mints one (201).
export type { SessionPublicShare } from '@kortix/sdk';
export {
  createSessionPublicShare,
  findActiveTranscriptShare,
  listSessionPublicShares,
  revokeSessionPublicShare,
} from '@kortix/sdk';

export type { SessionStartStage, SessionStartResult } from '@kortix/sdk';

/**
 * THE session-open call. Mobile's session-open loop needs the error, so it uses
 * `startProjectSessionOrThrow`, not `startProjectSession` (which yields `null`
 * on a transient failure):
 * - a 402 opens the upgrade sheet (`getUpgradeGate`, ProjectScreen);
 * - any other failure goes to `connectStepFromRequestError`
 *   (lib/session/connect-step.ts), which shows ONE error. A `null` here made
 *   the loop poll a broken request every 1.5 s for 4 min with no message.
 */
export { startProjectSessionOrThrow as startProjectSession } from '@kortix/sdk';

export type { ProjectSessionSandbox } from '@kortix/sdk';

// ── Project config detail (agents / skills / commands) ───────────────────────
// Web parity: GET /projects/:id/detail. The SDK's `ProjectConfigSummary` is a
// strict superset of mobile's old hand-rolled one (adds `signals`,
// `manifest_raw`, `open_code_raw`, `agent_discovery`, richer `agents[].scope`)
// — re-exported wholesale; existing consumers only read the fields they
// already used, extra fields are ignored.
export type { ProjectConfigSummary, ProjectDetail, ProjectLlmCatalogResponse } from '@kortix/sdk';
/** Derived aliases — mobile used to declare these as standalone interfaces;
 *  they're now just named views into `ProjectConfigSummary`'s array items so
 *  they can never drift from the real detail response. */
export type ProjectConfigEntry = sdk.ProjectConfigSummary['skills'][number];
export type ProjectAgentEntry = sdk.ProjectConfigSummary['agents'][number];

export {
  getModelDefaults,
  getProjectDetail,
  getProjectLlmCatalog,
  getProjectLlmCatalogProviders,
  getProjectModelPicker,
} from '@kortix/sdk';

// ── Connectors (web parity: connectors-view) ──────────────────────────────────

export type {
  ConnectorAction,
  AdminConnector,
  ConnectorsResponse,
  ConnectorSyncResult,
  ConnectorDraftInput,
} from '@kortix/sdk';
/** Mobile's narrower alias for `AdminConnector['provider']`. */
export type ConnectorProvider = sdk.AdminConnector['provider'];

export {
  listConnectors,
  syncConnectors,
  deleteConnector,
  setConnectorCredential,
  createConnector,
  pipedreamFinalize,
  listPipedreamApps,
} from '@kortix/sdk';

export type { PipedreamApp } from '@kortix/sdk';
/** Mobile-only page-cursor wrapper type (the SDK's `listPipedreamApps` returns
 *  this same shape inline rather than as a named export). */
export interface PipedreamAppsPage {
  apps: sdk.PipedreamApp[];
  nextCursor?: string;
  hasMore: boolean;
}

/** Disconnect a connector: remove its stored credential. */
export { deleteConnectorCredential as disconnectConnector } from '@kortix/sdk';

/**
 * Start the hosted connect flow. The redirect URIs send the in-app browser back
 * to the app once the OAuth flow finishes (components/session/ConnectorAuthSheet.tsx).
 */
export function pipedreamConnect(
  projectId: string,
  slug: string,
  redirects?: { successRedirectUri?: string; errorRedirectUri?: string },
) {
  return sdk.connectorConnect(projectId, slug, redirects);
}

// ── Project access (members) — full web parity (members-view) ────────────────

export type {
  ProjectGroupAccessSource,
  ProjectAccessMember,
  ProjectAccessResponse,
  InviteProjectMemberResult,
} from '@kortix/sdk';

export {
  listProjectAccess,
  updateProjectAccess,
  revokeProjectAccess,
  inviteProjectMember,
  isInviteSent,
} from '@kortix/sdk';

// ── Pending project invites (non-Kortix users not signed up yet) ─────────────

export type { PendingProjectInvite, ResendProjectInviteResult } from '@kortix/sdk';

export {
  listPendingProjectInvites,
  revokePendingProjectInvite,
  resendPendingProjectInvite,
} from '@kortix/sdk';

// ── Connector policies (tool-approval rules) ──────────────────────────────────

export type {
  PolicyAction,
  PolicyDefaultMode,
  ProjectPoliciesResponse,
  ProjectPolicy,
} from '@kortix/sdk';

export { listProjectPolicies, setProjectPolicies } from '@kortix/sdk';

// ── Project secrets (web parity: customize/sections/secrets-view) ─────────────

export type { ProjectSecret, ProjectSecretsResponse } from '@kortix/sdk';

/** Keeps the old defensive bare-array fallback on top of the SDK's version
 *  (belt-and-braces against a legacy response shape; harmless if never hit). */
export async function listProjectSecrets(projectId: string): Promise<sdk.ProjectSecretsResponse> {
  const res = await sdk.listProjectSecrets(projectId);
  if (Array.isArray(res)) return { items: res as unknown as sdk.ProjectSecret[], required: [], optional: [] };
  return { ...res, items: res.items ?? [] };
}

export {
  upsertProjectSecret,
  deleteProjectSecret,
  setPersonalProjectSecret,
  deletePersonalProjectSecret,
} from '@kortix/sdk';

// ── Default agent ───────────────────────────────────────────────────────────
export { updateProjectDefaultAgent } from '@kortix/sdk';

// ── Channels — Slack (web parity: customize/sections/channels-view) ───────────

export type { SlackInstallation, SlackMode } from '@kortix/sdk';

export { getSlackInstallation, getSlackMode, connectSlack, disconnectSlack } from '@kortix/sdk';

// ── Triggers — schedules (cron) + webhooks (web parity: triggers-view) ────────

export type {
  ProjectTriggerType,
  ProjectTrigger,
  ProjectTriggerParseError,
  ProjectTriggerListing,
  CreateProjectTriggerInput,
  UpdateProjectTriggerInput,
  FireProjectTriggerResponse,
} from '@kortix/sdk';

export {
  listProjectTriggers,
  createProjectTrigger,
  updateProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
} from '@kortix/sdk';

// ── Change requests (web parity: customize/sections/changes-view) ─────────────

export type {
  ChangeRequestStatus,
  ChangeRequest,
  ChangeRequestMergePreview,
  ProjectCommitFile,
  ProjectBranch,
  ProjectBranchesResponse,
  VersionDiffPreview,
} from '@kortix/sdk';
/** The SDK's `openChangeRequest` takes this as an inline (unnamed) type;
 *  derive the name mobile used to export rather than duplicating the shape. */
export type OpenChangeRequestInput = Parameters<typeof sdk.openChangeRequest>[1];
/** Mobile's name for the SDK's `ChangeRequestDiffResponse`. */
export type { ChangeRequestDiffResponse as ChangeRequestDiff } from '@kortix/sdk';
/** Mobile's name for the SDK's `ChangeRequestMergeResponse`. */
export type { ChangeRequestMergeResponse as ChangeRequestMergeResult } from '@kortix/sdk';

export {
  listChangeRequests,
  getChangeRequest,
  getChangeRequestDiff,
  getChangeRequestMergePreview,
  openChangeRequest,
  closeChangeRequest,
  reopenChangeRequest,
  listProjectBranches,
} from '@kortix/sdk';

/** Mobile calls this with a bare `message?: string`; the SDK takes `{ message? }`. */
export function mergeChangeRequest(projectId: string, crId: string, message?: string) {
  return sdk.mergeChangeRequest(projectId, crId, message ? { message } : undefined);
}

export { updateChangeRequest as patchChangeRequest } from '@kortix/sdk';

/** Mobile calls this with positional `(from, into)`; the SDK's `getVersionDiff`
 *  (it lives in `change-requests.ts`, not `git-history.ts`) takes `{ from, into }`. */
export function getVersionDiff(projectId: string, from: string, into: string) {
  return sdk.getVersionDiff(projectId, { from, into });
}

// ── Project files (web parity: features/project-files) ────────────────────────

export type { ProjectFileEntry } from '@kortix/sdk';
export type { ProjectCommit, ProjectFileHistoryResponse } from '@kortix/sdk';
/** Mobile's name for the SDK's `ProjectCommitDiffResponse`. */
export type { ProjectCommitDiffResponse } from '@kortix/sdk';

export { listProjectFiles, getProjectFileHistory, readProjectFile } from '@kortix/sdk';

/** Mobile calls this with a positional `path?: string`; the SDK's
 *  `getProjectCommitDiff` (in `git-history.ts`) takes `options?: { path? }`. */
export function getProjectCommitDiff(projectId: string, sha: string, path?: string) {
  return sdk.getProjectCommitDiff(projectId, sha, path ? { path } : undefined);
}

/** The archive download as `{ url, headers }`, for expo-file-system to stream to disk. */
export { projectArchiveRequest } from '@kortix/sdk';

// ── Sandbox (web parity: customize/sections/sandbox-view) ─────────────────────

export type {
  ProjectSnapshotStatus,
  SnapshotErrorCategory,
  SandboxTemplate,
  ProjectSnapshotBuild,
  ProjectSnapshotsResponse,
  CreateSandboxTemplateInput,
  UpdateSandboxTemplateInput,
} from '@kortix/sdk';

export {
  listProjectSnapshots,
  createSandboxTemplate,
  updateSandboxTemplate,
  buildSandboxTemplate,
  deleteSandboxTemplate,
  rebuildProjectSnapshot,
  fixSandboxWithAgent,
} from '@kortix/sdk';

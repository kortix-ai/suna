/**
 * Projects data client — now backed by @kortix/sdk/projects-client.
 *
 * This file used to hand-roll ~1560 lines re-implementing the same REST
 * surface the SDK now exposes (web-aligned, hits the same repo-first backend
 * endpoints: GET /accounts, GET /projects?account_id=, etc.). It's kept as a
 * single file so every existing mobile import path
 * (`@/lib/projects/projects-client`) keeps working unchanged — see the SDK
 * adoption report for the function-by-function mapping.
 *
 * Most functions below are thin re-exports of `@kortix/sdk/projects-client`.
 * A handful are kept mobile-native because the SDK's equivalent has different
 * error/behavior semantics or doesn't cover the endpoint at all — each is
 * commented with why.
 */

import { API_URL, getAuthToken } from '@/api/config';
import { createApiRequestError, getUpgradeGate } from '@/lib/billing/upgrade-gate';
import { backendApi } from '@kortix/sdk/api-client';
import * as sdk from '@kortix/sdk/projects-client';

// ── Generic fetch helper ────────────────────────────────────────────────────
// Kept mobile-native: this is the shared primitive for endpoints the SDK does
// NOT cover at all (account-level IAM groups/MFA/session-policy/PAT-policy/
// service-accounts/audit — see lib/accounts/{accounts-client,groups-client,
// iam-client}.ts, all of which import `apiFetch` from this file) as well as
// the couple of functions below kept mobile-native for behavioral reasons.
// Uses the same token source (`api/config.ts#getAuthToken`) that's wired into
// `configureKortix({ getToken })`, so both paths share one auth story.

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text ? { message: text.slice(0, 200) } : null;
    }
    throw createApiRequestError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Unwrap an `@kortix/sdk` `backendApi` response for the handful of endpoints
 *  the SDK's `projects-client` doesn't cover (kept local — `unwrap` itself is
 *  an internal SDK helper, not part of its public surface). */
function unwrapLocal<T>(
  response: { data?: T; success: boolean; error?: Error },
  fallbackMessage = 'Project request failed',
): T {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error(fallbackMessage);
  }
  return response.data;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export type { AccountRole, ProjectRole, ConnectorSharing } from '@kortix/sdk/projects-client';
export type { KortixAccount } from '@kortix/sdk/projects-client';

export { listAccounts } from '@kortix/sdk/projects-client';

/** Mobile calls this with a bare `name` string; the SDK takes `{ name }`. */
export function createAccount(name: string) {
  return sdk.createAccount({ name });
}

// ── Projects ───────────────────────────────────────────────────────────────

export type {
  KortixProject,
  ExperimentalFeatureKey,
  ExperimentalFeatureView,
  ProjectInput,
  ProvisionProjectInput,
  RepoCollaboratorInvite,
} from '@kortix/sdk/projects-client';

export {
  listProjectsForAccount,
  getProject,
  inviteRepoCollaborator,
  isManagedGithubProject,
  archiveProject,
  updateProject,
  updateExperimentalFeature,
  provisionProject,
} from '@kortix/sdk/projects-client';

// ── Dev (web parity: customize/sections/dev-view) ─────────────────────────────
// inviteRepoCollaborator / isManagedGithubProject re-exported above.

// ── Project sessions (one branch + sandbox per row; web-aligned) ────────────

export type { ProjectSessionStatus, ProjectSession } from '@kortix/sdk/projects-client';
/** The SDK's `createProjectSession` takes this as an inline (unnamed) type;
 *  derive the name mobile used to export rather than duplicating the shape. */
export type CreateProjectSessionInput = NonNullable<Parameters<typeof sdk.createProjectSession>[1]>;
/** Mobile's own name for the SDK's `ConnectorSharing` reused on sessions. */
export type { ConnectorSharing as SessionSharing } from '@kortix/sdk/projects-client';

export {
  listProjectSessions,
  createProjectSession,
  restartProjectSession,
  updateProjectSession,
  deleteProjectSession,
  setProjectSessionSharing,
} from '@kortix/sdk/projects-client';

export type { SessionStartStage, SessionStartResult } from '@kortix/sdk/projects-client';

/**
 * THE session-open call — kept MOBILE-NATIVE rather than re-exporting
 * `@kortix/sdk/projects-client`'s `startProjectSession`.
 *
 * Mismatch found: the SDK's version NEVER throws — on any failure (including
 * a 402 billing gate) it just returns `null` and expects the *page* to have
 * already gated billing before polling (its own comment: "402 (billing) is
 * handled by the page's plan gate before polling"). Mobile's flow instead
 * discovers the billing gate BY catching this call's thrown error — see
 * `getUpgradeGate` below and its use in app/projects/[id].tsx /
 * components/billing/GlobalUpgradeSheet.tsx. Swapping to the SDK's
 * swallow-everything version would silently turn a billing paywall into an
 * infinite "provisioning" retry loop. Kept native; still hits the same
 * `/start` endpoint via `apiFetch` so behavior elsewhere is unchanged.
 */
export async function startProjectSession(
  projectId: string,
  sessionId: string,
): Promise<sdk.SessionStartResult | null> {
  try {
    return await apiFetch<sdk.SessionStartResult>(
      `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/start`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  } catch (error) {
    if (getUpgradeGate(error)) throw error;
    return null;
  }
}

export type { ProjectSessionSandbox } from '@kortix/sdk/projects-client';

// ── Project config detail (agents / skills / commands) ───────────────────────
// Web parity: GET /projects/:id/detail. The SDK's `ProjectConfigSummary` is a
// strict superset of mobile's old hand-rolled one (adds `signals`,
// `manifest_raw`, `open_code_raw`, `agent_discovery`, richer `agents[].scope`)
// — re-exported wholesale; existing consumers only read the fields they
// already used, extra fields are ignored.
export type { ProjectConfigSummary, ProjectDetail, ProjectLlmCatalogResponse } from '@kortix/sdk/projects-client';
/** Derived aliases — mobile used to declare these as standalone interfaces;
 *  they're now just named views into `ProjectConfigSummary`'s array items so
 *  they can never drift from the real detail response. */
export type ProjectConfigEntry = sdk.ProjectConfigSummary['skills'][number];
export type ProjectAgentEntry = sdk.ProjectConfigSummary['agents'][number];

export { getProjectDetail, getProjectLlmCatalog } from '@kortix/sdk/projects-client';

// ── Executor connectors (web parity: connectors-view) ────────────────────────

export type {
  ConnectorAction,
  AdminConnector,
  ConnectorsResponse,
  ConnectorSyncResult,
  ConnectorDraftInput,
} from '@kortix/sdk/projects-client';
/** Mobile's narrower alias for `AdminConnector['provider']`. */
export type ConnectorProvider = sdk.AdminConnector['provider'];

export {
  listConnectors,
  syncConnectors,
  deleteConnector,
  setConnectorSharing,
  setConnectorCredential,
  createConnector,
  pipedreamFinalize,
  listPipedreamApps,
} from '@kortix/sdk/projects-client';

export type { PipedreamApp } from '@kortix/sdk/projects-client';
/** Mobile-only page-cursor wrapper type (the SDK's `listPipedreamApps` returns
 *  this same shape inline rather than as a named export). */
export interface PipedreamAppsPage {
  apps: sdk.PipedreamApp[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Kept MOBILE-NATIVE: the SDK's `@kortix/sdk/projects-client` has no
 * `disconnectConnector` — its `connectors.ts` only exposes `setConnectorCredential`
 * (PUT) with no DELETE counterpart. Same endpoint mobile always used
 * (`DELETE /executor/projects/:id/connectors/:slug/credential`), implemented
 * directly against the SDK's `backendApi` so it still shares auth/config.
 */
export async function disconnectConnector(projectId: string, slug: string) {
  return unwrapLocal(
    await backendApi.delete<{ ok: boolean }>(
      `/executor/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(slug)}/credential`,
    ),
  );
}

/**
 * Kept MOBILE-NATIVE: the SDK's `pipedreamConnect(projectId, slug)` sends an
 * EMPTY body. Mobile needs `success_redirect_uri`/`error_redirect_uri` so the
 * in-app browser auto-dismisses back to the app once Pipedream's OAuth flow
 * finishes (see components/pages/ConnectorsPage.tsx) — swapping to the SDK's
 * version would silently drop those redirects. Same endpoint, same response
 * shape as the SDK's version; only the request body differs.
 */
export async function pipedreamConnect(
  projectId: string,
  slug: string,
  redirects?: { successRedirectUri?: string; errorRedirectUri?: string },
) {
  return unwrapLocal(
    await backendApi.post<{ token?: string; app?: string; connectUrl?: string }>(
      `/executor/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(slug)}/connect`,
      {
        ...(redirects?.successRedirectUri ? { success_redirect_uri: redirects.successRedirectUri } : {}),
        ...(redirects?.errorRedirectUri ? { error_redirect_uri: redirects.errorRedirectUri } : {}),
      },
    ),
  );
}

// ── Project access (members) — full web parity (members-view) ────────────────

export type {
  ProjectGroupAccessSource,
  ProjectAccessMember,
  ProjectAccessResponse,
  InviteProjectMemberResult,
} from '@kortix/sdk/projects-client';

export {
  listProjectAccess,
  updateProjectAccess,
  revokeProjectAccess,
  inviteProjectMember,
  isInviteSent,
} from '@kortix/sdk/projects-client';

// ── Pending project invites (non-Kortix users not signed up yet) ─────────────

export type { PendingProjectInvite, ResendProjectInviteResult } from '@kortix/sdk/projects-client';

export {
  listPendingProjectInvites,
  revokePendingProjectInvite,
  resendPendingProjectInvite,
} from '@kortix/sdk/projects-client';

// ── IAM V2: project ⇄ group attachments (project-scoped) ─────────────────────
// NOTE: account-LEVEL group listing (`listAccountGroups`, `removeGroupMember`)
// has no SDK equivalent — the SDK's `access.ts` only covers PROJECT-scoped
// group grants. Kept mobile-native below via `apiFetch`.

export type { ProjectGroupGrant } from '@kortix/sdk/projects-client';

export {
  listProjectGroupGrants,
  attachGroupToProject,
  updateProjectGroupGrant,
  detachGroupFromProject,
} from '@kortix/sdk/projects-client';

/** Account-level group directory — NOT covered by `@kortix/sdk/projects-client`
 *  (its `access.ts` only has project ⇄ group grants, not the account's group
 *  list). Mirrors the type mobile's `lib/accounts/groups-client.ts` re-exports. */
export interface AccountGroup {
  group_id: string;
  name: string;
  description: string | null;
  source: 'manual' | 'scim';
  member_count?: number;
  project_count?: number;
  created_at: string;
  updated_at: string;
}

export function listAccountGroups(accountId: string) {
  return apiFetch<{ groups: AccountGroup[] }>(
    `/accounts/${encodeURIComponent(accountId)}/iam/groups`,
  ).then((r) => r.groups);
}

export function removeGroupMember(accountId: string, groupId: string, userId: string) {
  return apiFetch<{ removed: boolean }>(
    `/accounts/${encodeURIComponent(accountId)}/iam/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

// ── Executor policies (tool-approval rules) ──────────────────────────────────

export type { PolicyAction, PolicyDefaultMode, ProjectPolicy, ProjectPoliciesResponse } from '@kortix/sdk/projects-client';

export { listProjectPolicies, setProjectPolicies } from '@kortix/sdk/projects-client';

// ── GitHub import ──────────────────────────────────────────────────────────

export type {
  GitHubRepository,
  GitHubRepositoriesResponse,
  GitHubInstallationStatus,
  GitHubInstallationsResponse,
  LinkRepositoryInput,
  LinkRepositoryResponse,
} from '@kortix/sdk/projects-client';

export {
  listGitHubInstallations,
  listGitHubRepositories,
  deleteGitHubInstallation,
  linkRepository,
} from '@kortix/sdk/projects-client';

// ── Project secrets (web parity: customize/sections/secrets-view) ─────────────

export type { ProjectSecret, ProjectSecretsResponse } from '@kortix/sdk/projects-client';

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
} from '@kortix/sdk/projects-client';

// ── Channels — Slack (web parity: customize/sections/channels-view) ───────────

export type { SlackInstallation, SlackMode } from '@kortix/sdk/projects-client';

export { getSlackInstallation, getSlackMode, connectSlack, disconnectSlack } from '@kortix/sdk/projects-client';

// ── Triggers — schedules (cron) + webhooks (web parity: triggers-view) ────────

export type {
  ProjectTriggerType,
  ProjectTrigger,
  ProjectTriggerParseError,
  ProjectTriggerListing,
  CreateProjectTriggerInput,
  UpdateProjectTriggerInput,
  FireProjectTriggerResponse,
} from '@kortix/sdk/projects-client';

export {
  listProjectTriggers,
  createProjectTrigger,
  updateProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
} from '@kortix/sdk/projects-client';

// ── Change requests (web parity: customize/sections/changes-view) ─────────────

export type {
  ChangeRequestStatus,
  ChangeRequest,
  ChangeRequestMergePreview,
  ProjectCommitFile,
  ProjectBranch,
  ProjectBranchesResponse,
  VersionDiffPreview,
} from '@kortix/sdk/projects-client';
/** The SDK's `openChangeRequest` takes this as an inline (unnamed) type;
 *  derive the name mobile used to export rather than duplicating the shape. */
export type OpenChangeRequestInput = Parameters<typeof sdk.openChangeRequest>[1];
/** Mobile's name for the SDK's `ChangeRequestDiffResponse`. */
export type { ChangeRequestDiffResponse as ChangeRequestDiff } from '@kortix/sdk/projects-client';
/** Mobile's name for the SDK's `ChangeRequestMergeResponse`. */
export type { ChangeRequestMergeResponse as ChangeRequestMergeResult } from '@kortix/sdk/projects-client';

export {
  listChangeRequests,
  getChangeRequest,
  getChangeRequestDiff,
  getChangeRequestMergePreview,
  openChangeRequest,
  closeChangeRequest,
  reopenChangeRequest,
  listProjectBranches,
} from '@kortix/sdk/projects-client';

/** Mobile calls this with a bare `message?: string`; the SDK takes `{ message? }`. */
export function mergeChangeRequest(projectId: string, crId: string, message?: string) {
  return sdk.mergeChangeRequest(projectId, crId, message ? { message } : undefined);
}

/**
 * Kept MOBILE-NATIVE: the SDK's `change-requests.ts` has no `patchChangeRequest`
 * (title/description edit) — only create/merge/close/reopen/diff/preview.
 * Same endpoint (`PATCH /projects/:id/change-requests/:crId`), implemented
 * directly against the SDK's `backendApi`.
 */
export async function patchChangeRequest(
  projectId: string,
  crId: string,
  input: { title?: string; description?: string },
) {
  return unwrapLocal(
    await backendApi.patch<sdk.ChangeRequest>(
      `/projects/${encodeURIComponent(projectId)}/change-requests/${encodeURIComponent(crId)}`,
      input,
    ),
  );
}

/** Mobile calls this with positional `(from, into)`; the SDK's `getVersionDiff`
 *  (it lives in `change-requests.ts`, not `git-history.ts`) takes `{ from, into }`. */
export function getVersionDiff(projectId: string, from: string, into: string) {
  return sdk.getVersionDiff(projectId, { from, into });
}

// ── Project files (web parity: features/project-files) ────────────────────────

export type { ProjectFileEntry } from '@kortix/sdk/projects-client';
export type { ProjectCommit, ProjectFileHistoryResponse } from '@kortix/sdk/projects-client';
/** Mobile's name for the SDK's `ProjectCommitDiffResponse`. */
export type { ProjectCommitDiffResponse } from '@kortix/sdk/projects-client';

export { listProjectFiles, getProjectFileHistory, readProjectFile } from '@kortix/sdk/projects-client';

/** Mobile calls this with a positional `path?: string`; the SDK's
 *  `getProjectCommitDiff` (in `git-history.ts`) takes `options?: { path? }`. */
export function getProjectCommitDiff(projectId: string, sha: string, path?: string) {
  return sdk.getProjectCommitDiff(projectId, sha, path ? { path } : undefined);
}

/** Kept mobile-native: a pure URL formatter (used with expo-file-system, which
 *  wants a URL string, not the SDK's Blob-returning `fetchProjectArchive`). */
export function projectArchiveUrl(projectId: string, ref: string, path?: string): string {
  const params = new URLSearchParams();
  if (ref) params.set('ref', ref);
  if (path) params.set('path', path);
  const qs = params.toString();
  return `${API_URL}/projects/${encodeURIComponent(projectId)}/files/archive${qs ? `?${qs}` : ''}`;
}

// ── Sandbox (web parity: customize/sections/sandbox-view) ─────────────────────

export type {
  ProjectSnapshotStatus,
  SnapshotErrorCategory,
  SandboxTemplate,
  ProjectSnapshotBuild,
  ProjectSnapshotsResponse,
  CreateSandboxTemplateInput,
  UpdateSandboxTemplateInput,
} from '@kortix/sdk/projects-client';

export {
  listProjectSnapshots,
  createSandboxTemplate,
  updateSandboxTemplate,
  buildSandboxTemplate,
  deleteSandboxTemplate,
  rebuildProjectSnapshot,
  fixSandboxWithAgent,
} from '@kortix/sdk/projects-client';

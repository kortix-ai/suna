/**
 * Workspaces data client — now backed by @kortix/sdk/workspaces-client.
 *
 * This file used to hand-roll ~1560 lines re-implementing the same REST
 * surface the SDK now exposes (web-aligned, hits the same repo-first backend
 * endpoints: GET /accounts, GET /workspaces?account_id=, etc.). It stays as a
 * single file so every existing mobile import path
 * (`@/lib/workspaces/workspaces-client`) stays stable — see the SDK
 * adoption report for the function-by-function mapping.
 *
 * Most functions below are thin re-exports of `@kortix/sdk/workspaces-client`.
 * A handful are kept mobile-native because the SDK's equivalent has different
 * error/behavior semantics or doesn't cover the endpoint at all — each is
 * commented with why.
 */

import { API_URL, getAuthToken } from '@/api/config';
import { createApiRequestError, getUpgradeGate } from '@/lib/billing/upgrade-gate';
import { backendApi } from '@kortix/sdk/api-client';
import * as sdk from '@kortix/sdk/workspaces-client';

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
 *  the SDK's Workspace client does not cover (kept local — `unwrap` itself is
 *  an internal SDK helper, not part of its public surface). */
function unwrapLocal<T>(
  response: { data?: T; success: boolean; error?: Error },
  fallbackMessage = 'Workspace request failed',
): T {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error(fallbackMessage);
  }
  return response.data;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export type { AccountRole, WorkspaceRole, ConnectorSharing } from '@kortix/sdk/workspaces-client';
export type { KortixAccount } from '@kortix/sdk/workspaces-client';

export { listAccounts } from '@kortix/sdk/workspaces-client';

/** Mobile calls this with a bare `name` string; the SDK takes `{ name }`. */
export function createAccount(name: string) {
  return sdk.createAccount({ name });
}

// ── Workspaces ─────────────────────────────────────────────────────────────

export type {
  KortixWorkspace,
  FeatureFlagKey,
  FeatureFlagView,
  WorkspaceInput,
  ProvisionWorkspaceInput,
  RepoCollaboratorInvite,
} from '@kortix/sdk/workspaces-client';

export {
  listWorkspacesForAccount,
  getWorkspace,
  inviteRepoCollaborator,
  isManagedGithubWorkspace,
  archiveWorkspace,
  updateWorkspace,
  updateFeatureFlag,
  provisionWorkspace,
} from '@kortix/sdk/workspaces-client';

// ── Dev (web parity: customize/sections/dev-view) ─────────────────────────────
// inviteRepoCollaborator / isManagedGithubWorkspace re-exported above.

// ── Workspace sessions (one branch + sandbox per row; web-aligned) ────────────

export type { WorkspaceSessionStatus, WorkspaceSession } from '@kortix/sdk/workspaces-client';
/** The SDK's `createWorkspaceSession` takes this as an inline (unnamed) type;
 *  derive the name mobile used to export rather than duplicating the shape. */
export type CreateWorkspaceSessionInput = NonNullable<Parameters<typeof sdk.createWorkspaceSession>[1]>;
/** Mobile's own name for the SDK's `ConnectorSharing` reused on sessions. */
export type { ConnectorSharing as SessionSharing } from '@kortix/sdk/workspaces-client';

export {
  listWorkspaceSessions,
  createWorkspaceSession,
  restartWorkspaceSession,
  stopWorkspaceSession,
  updateWorkspaceSession,
  deleteWorkspaceSession,
  setWorkspaceSessionSharing,
} from '@kortix/sdk/workspaces-client';

export type { SessionStartStage, SessionStartResult } from '@kortix/sdk/workspaces-client';

/**
 * THE session-open call — kept MOBILE-NATIVE rather than re-exporting
 * `@kortix/sdk/workspaces-client`'s `startWorkspaceSession`.
 *
 * Mismatch found: the SDK's version NEVER throws — on any failure (including
 * a 402 billing gate) it just returns `null` and expects the *page* to have
 * already gated billing before polling. Mobile's flow instead
 * discovers the billing gate BY catching this call's thrown error — see
 * `getUpgradeGate` below and its use in app/workspaces/[id].tsx /
 * components/billing/GlobalUpgradeSheet.tsx. Swapping to the SDK's
 * swallow-everything version would silently turn a billing paywall into an
 * infinite "provisioning" retry loop. Kept native; still hits the same
 * canonical `/start` endpoint via `apiFetch` so behavior elsewhere is unchanged.
 */
export async function startWorkspaceSession(
  workspaceId: string,
  sessionId: string,
): Promise<sdk.SessionStartResult | null> {
  try {
    return await apiFetch<sdk.SessionStartResult>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/start`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  } catch (error) {
    if (getUpgradeGate(error)) throw error;
    return null;
  }
}

export type { WorkspaceSessionSandbox } from '@kortix/sdk/workspaces-client';

// ── Workspace config detail (agents / skills / commands) ───────────────────────
// Web parity: GET /workspaces/:id/detail. The SDK's `WorkspaceConfigSummary` is a
// strict superset of mobile's old hand-rolled one (adds `signals`,
// `manifest_raw`, `open_code_raw`, `agent_discovery`, richer `agents[].scope`)
// — re-exported wholesale; existing consumers only read the fields they
// already used, extra fields are ignored.
export type { WorkspaceConfigSummary, WorkspaceDetail, WorkspaceLlmCatalogResponse } from '@kortix/sdk/workspaces-client';
/** Derived aliases — mobile used to declare these as standalone interfaces;
 *  they're now just named views into `WorkspaceConfigSummary`'s array items so
 *  they can never drift from the real detail response. */
export type WorkspaceConfigEntry = sdk.WorkspaceConfigSummary['skills'][number];
export type WorkspaceAgentEntry = sdk.WorkspaceConfigSummary['agents'][number];

export { getWorkspaceDetail, getWorkspaceLlmCatalog } from '@kortix/sdk/workspaces-client';

// ── Connectors (web parity: connectors-view) ──────────────────────────────────

export type {
  ConnectorAction,
  AdminConnector,
  ConnectorsResponse,
  ConnectorSyncResult,
  ConnectorDraftInput,
} from '@kortix/sdk/workspaces-client';
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
} from '@kortix/sdk/workspaces-client';

export type { PipedreamApp } from '@kortix/sdk/workspaces-client';
/** Mobile-only page-cursor wrapper type (the SDK's `listPipedreamApps` returns
 *  this same shape inline rather than as a named export). */
export interface PipedreamAppsPage {
  apps: sdk.PipedreamApp[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Kept MOBILE-NATIVE: the SDK's `@kortix/sdk/workspaces-client` has no
 * `disconnectConnector` — its `connectors.ts` only exposes `setConnectorCredential`
 * (PUT) with no DELETE counterpart. Same endpoint mobile always used
 * (`DELETE /connectors/workspaces/:id/connectors/:slug/credential`), implemented
 * directly against the SDK's `backendApi` so it still shares auth/config.
 */
export async function disconnectConnector(workspaceId: string, slug: string) {
  return unwrapLocal(
    await backendApi.delete<{ ok: boolean }>(
      `/connectors/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(slug)}/credential`,
    ),
  );
}

/**
 * Kept MOBILE-NATIVE: the SDK's `pipedreamConnect(workspaceId, slug)` sends an
 * EMPTY body. Mobile needs `success_redirect_uri`/`error_redirect_uri` so the
 * in-app browser auto-dismisses back to the app once Pipedream's OAuth flow
 * finishes (see components/pages/ConnectorsPage.tsx) — swapping to the SDK's
 * version would silently drop those redirects. Same endpoint, same response
 * shape as the SDK's version; only the request body differs.
 */
export async function pipedreamConnect(
  workspaceId: string,
  slug: string,
  redirects?: { successRedirectUri?: string; errorRedirectUri?: string },
) {
  return unwrapLocal(
    await backendApi.post<{ token?: string; app?: string; connectUrl?: string }>(
      `/connectors/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(slug)}/connect`,
      {
        ...(redirects?.successRedirectUri ? { success_redirect_uri: redirects.successRedirectUri } : {}),
        ...(redirects?.errorRedirectUri ? { error_redirect_uri: redirects.errorRedirectUri } : {}),
      },
    ),
  );
}

// ── Workspace access (members) — full web parity (members-view) ────────────────

export type {
  WorkspaceGroupAccessSource,
  WorkspaceAccessMember,
  WorkspaceAccessResponse,
  InviteWorkspaceMemberResult,
} from '@kortix/sdk/workspaces-client';

export {
  listWorkspaceAccess,
  updateWorkspaceAccess,
  revokeWorkspaceAccess,
  inviteWorkspaceMember,
  isInviteSent,
} from '@kortix/sdk/workspaces-client';

// ── Pending Workspace invites (non-Kortix users not signed up yet) ───────────

export type { PendingWorkspaceInvite, ResendWorkspaceInviteResult } from '@kortix/sdk/workspaces-client';

export {
  listPendingWorkspaceInvites,
  revokePendingWorkspaceInvite,
  resendPendingWorkspaceInvite,
} from '@kortix/sdk/workspaces-client';

// ── IAM V2: Workspace-to-group attachments ──────────────────────────────────
// NOTE: account-LEVEL group listing (`listAccountGroups`, `removeGroupMember`)
// has no SDK equivalent — the SDK's `access.ts` only covers Workspace-scoped
// group grants. Kept mobile-native below via `apiFetch`.

export type { WorkspaceGroupGrant } from '@kortix/sdk/workspaces-client';

export {
  listWorkspaceGroupGrants,
  attachGroupToWorkspace,
  updateWorkspaceGroupGrant,
  detachGroupFromWorkspace,
} from '@kortix/sdk/workspaces-client';

/** Account-level group directory — NOT covered by `@kortix/sdk/workspaces-client`
 *  (its `access.ts` only has Workspace-to-group grants, not the account's group
 *  list). Mirrors the type mobile's `lib/accounts/groups-client.ts` re-exports. */
export interface AccountGroup {
  group_id: string;
  name: string;
  description: string | null;
  source: 'manual' | 'scim';
  member_count?: number;
  workspace_count?: number;
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

// ── Connector policies (tool-approval rules) ──────────────────────────────────

export type { PolicyAction, PolicyDefaultMode, WorkspacePolicy, WorkspacePoliciesResponse } from '@kortix/sdk/workspaces-client';

export { listWorkspacePolicies, setWorkspacePolicies } from '@kortix/sdk/workspaces-client';

// ── GitHub import ──────────────────────────────────────────────────────────

export type {
  GitHubRepository,
  GitHubRepositoriesResponse,
  GitHubInstallationStatus,
  GitHubInstallationsResponse,
  LinkRepositoryInput,
  LinkRepositoryResponse,
} from '@kortix/sdk/workspaces-client';

export {
  listGitHubInstallations,
  listGitHubRepositories,
  deleteGitHubInstallation,
  linkRepository,
} from '@kortix/sdk/workspaces-client';

// ── Workspace secrets (web parity: customize/sections/secrets-view) ──────────

export type { WorkspaceSecret, WorkspaceSecretsResponse } from '@kortix/sdk/workspaces-client';

/** Keeps the old defensive bare-array fallback on top of the SDK's version
 *  (belt-and-braces against a legacy response shape; harmless if never hit). */
export async function listWorkspaceSecrets(workspaceId: string): Promise<sdk.WorkspaceSecretsResponse> {
  const res = await sdk.listWorkspaceSecrets(workspaceId);
  if (Array.isArray(res)) return { items: res as unknown as sdk.WorkspaceSecret[], required: [], optional: [] };
  return { ...res, items: res.items ?? [] };
}

export {
  upsertWorkspaceSecret,
  deleteWorkspaceSecret,
  setPersonalWorkspaceSecret,
  deletePersonalWorkspaceSecret,
} from '@kortix/sdk/workspaces-client';

// ── Channels — Slack (web parity: customize/sections/channels-view) ───────────

export type { SlackInstallation, SlackMode } from '@kortix/sdk/workspaces-client';

export { getSlackInstallation, getSlackMode, connectSlack, disconnectSlack } from '@kortix/sdk/workspaces-client';

// ── Triggers — schedules (cron) + webhooks (web parity: triggers-view) ────────

export type {
  WorkspaceTriggerType,
  WorkspaceTrigger,
  WorkspaceTriggerParseError,
  WorkspaceTriggerListing,
  CreateWorkspaceTriggerInput,
  UpdateWorkspaceTriggerInput,
  FireWorkspaceTriggerResponse,
} from '@kortix/sdk/workspaces-client';

export {
  listWorkspaceTriggers,
  createWorkspaceTrigger,
  updateWorkspaceTrigger,
  deleteWorkspaceTrigger,
  fireWorkspaceTrigger,
} from '@kortix/sdk/workspaces-client';

// ── Change requests (web parity: customize/sections/changes-view) ─────────────

export type {
  ChangeRequestStatus,
  ChangeRequest,
  ChangeRequestMergePreview,
  WorkspaceCommitFile,
  WorkspaceBranch,
  WorkspaceBranchesResponse,
  VersionDiffPreview,
} from '@kortix/sdk/workspaces-client';
/** The SDK's `openChangeRequest` takes this as an inline (unnamed) type;
 *  derive the name mobile used to export rather than duplicating the shape. */
export type OpenChangeRequestInput = Parameters<typeof sdk.openChangeRequest>[1];
/** Mobile's name for the SDK's `ChangeRequestDiffResponse`. */
export type { ChangeRequestDiffResponse as ChangeRequestDiff } from '@kortix/sdk/workspaces-client';
/** Mobile's name for the SDK's `ChangeRequestMergeResponse`. */
export type { ChangeRequestMergeResponse as ChangeRequestMergeResult } from '@kortix/sdk/workspaces-client';

export {
  listChangeRequests,
  getChangeRequest,
  getChangeRequestDiff,
  getChangeRequestMergePreview,
  openChangeRequest,
  closeChangeRequest,
  reopenChangeRequest,
  listWorkspaceBranches,
} from '@kortix/sdk/workspaces-client';

/** Mobile calls this with a bare `message?: string`; the SDK takes `{ message? }`. */
export function mergeChangeRequest(workspaceId: string, crId: string, message?: string) {
  return sdk.mergeChangeRequest(workspaceId, crId, message ? { message } : undefined);
}

/**
 * Kept MOBILE-NATIVE: the SDK's `change-requests.ts` has no `patchChangeRequest`
 * (title/description edit) — only create/merge/close/reopen/diff/preview.
 * Same endpoint (`PATCH /workspaces/:id/change-requests/:crId`), implemented
 * directly against the SDK's `backendApi`.
 */
export async function patchChangeRequest(
  workspaceId: string,
  crId: string,
  input: { title?: string; description?: string },
) {
  return unwrapLocal(
    await backendApi.patch<sdk.ChangeRequest>(
      `/workspaces/${encodeURIComponent(workspaceId)}/change-requests/${encodeURIComponent(crId)}`,
      input,
    ),
  );
}

/** Mobile calls this with positional `(from, into)`; the SDK's `getVersionDiff`
 *  (it lives in `change-requests.ts`, not `git-history.ts`) takes `{ from, into }`. */
export function getVersionDiff(workspaceId: string, from: string, into: string) {
  return sdk.getVersionDiff(workspaceId, { from, into });
}

// ── Workspace files (web parity: features/workspace-files) ─────────────────────

export type { WorkspaceFileEntry } from '@kortix/sdk/workspaces-client';
export type { WorkspaceCommit, WorkspaceFileHistoryResponse } from '@kortix/sdk/workspaces-client';
/** Mobile's name for the SDK's `WorkspaceCommitDiffResponse`. */
export type { WorkspaceCommitDiffResponse } from '@kortix/sdk/workspaces-client';

export { listWorkspaceFiles, getWorkspaceFileHistory, readWorkspaceFile } from '@kortix/sdk/workspaces-client';

/** Mobile calls this with a positional `path?: string`; the SDK's
 *  `getWorkspaceCommitDiff` (in `git-history.ts`) takes `options?: { path? }`. */
export function getWorkspaceCommitDiff(workspaceId: string, sha: string, path?: string) {
  return sdk.getWorkspaceCommitDiff(workspaceId, sha, path ? { path } : undefined);
}

/** Kept mobile-native: a pure URL formatter (used with expo-file-system, which
 *  wants a URL string, not the SDK's Blob-returning `fetchWorkspaceArchive`). */
export function workspaceArchiveUrl(workspaceId: string, ref: string, path?: string): string {
  const params = new URLSearchParams();
  if (ref) params.set('ref', ref);
  if (path) params.set('path', path);
  const qs = params.toString();
  return `${API_URL}/workspaces/${encodeURIComponent(workspaceId)}/files/archive${qs ? `?${qs}` : ''}`;
}

// ── Sandbox (web parity: customize/sections/sandbox-view) ─────────────────────

export type {
  WorkspaceSnapshotStatus,
  SnapshotErrorCategory,
  SandboxTemplate,
  WorkspaceSnapshotBuild,
  WorkspaceSnapshotsResponse,
  CreateSandboxTemplateInput,
  UpdateSandboxTemplateInput,
} from '@kortix/sdk/workspaces-client';

export {
  listWorkspaceSnapshots,
  createSandboxTemplate,
  updateSandboxTemplate,
  buildSandboxTemplate,
  deleteSandboxTemplate,
  rebuildWorkspaceSnapshot,
  fixSandboxWithAgent,
} from '@kortix/sdk/workspaces-client';

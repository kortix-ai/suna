/** Platform-managed GitHub connection lifecycle through Nango. */

import { backendApi } from '../../http/api-client';
import { ApiError } from '../../http/api/errors';

export interface ManagedGitHubCandidate {
  connection_id: string;
  integration_id: string;
  display_name: string;
  installation_id: string | null;
  owner: {
    login: string;
    type: 'Organization';
  } | null;
  status: 'connected' | 'needs_reconnect' | 'error';
  selected: boolean;
  repository_selection?: string;
  permissions: Record<string, unknown>;
}

export interface ManagedGitHubConnectSession {
  token: string;
  expires_at: string;
  connect_link: string;
}

export interface ManagedGitHubStatus {
  configured: boolean;
  owner: string | null;
  slug: string | null;
  installation_id: string | null;
  source: 'nango' | 'db' | 'env' | 'pat' | 'none';
  selected: ManagedGitHubCandidate | null;
  candidates?: ManagedGitHubCandidate[];
  reason?: string;
}

export async function getManagedGitHubStatus(): Promise<ManagedGitHubStatus> {
  const response = await backendApi.get<ManagedGitHubStatus>('/platform/github-app/status', {
    showErrors: false,
  });
  if (response.error) throw response.error;
  if (!response.data) throw new Error('Managed GitHub status request failed');
  return response.data;
}

export async function createManagedGitHubConnectSession(): Promise<ManagedGitHubConnectSession> {
  const response = await backendApi.post<ManagedGitHubConnectSession>(
    '/platform/github-app/connect-session',
    {},
    { showErrors: false },
  );
  if (response.error) throw response.error;
  if (!response.data) throw new Error('Managed GitHub Connect session request failed');
  return response.data;
}

export async function listManagedGitHubCandidates(): Promise<ManagedGitHubCandidate[]> {
  const response = await backendApi.get<{ candidates: ManagedGitHubCandidate[] }>(
    '/platform/github-app/candidates',
    { showErrors: false },
  );
  if (response.error) throw response.error;
  if (!response.data) throw new Error('Managed GitHub candidate request failed');
  return response.data.candidates;
}

export async function selectManagedGitHubCandidate(
  connectionId: string,
): Promise<{ candidate: ManagedGitHubCandidate }> {
  const response = await backendApi.post<{ candidate: ManagedGitHubCandidate }>(
    '/platform/github-app/select',
    { connection_id: connectionId },
    { showErrors: false },
  );
  if (response.error) throw response.error;
  if (!response.data) throw new Error('Managed GitHub candidate selection failed');
  return response.data;
}

export async function createManagedGitHubReconnectSession(
  connectionId: string,
): Promise<ManagedGitHubConnectSession> {
  const response = await backendApi.post<ManagedGitHubConnectSession>(
    '/platform/github-app/reconnect-session',
    { connection_id: connectionId },
    { showErrors: false },
  );
  if (response.error) throw response.error;
  if (!response.data) throw new Error('Managed GitHub reconnect session request failed');
  return response.data;
}

export async function disconnectManagedGitHubConnection(): Promise<{ ok: true }> {
  const response = await backendApi.delete<{ ok: true }>('/platform/github-app/connection', {
    showErrors: false,
  });
  if (response.error) throw response.error;
  if (!response.data) throw new Error('Managed GitHub disconnect request failed');
  return response.data;
}

/** @deprecated Use `ManagedGitHubStatus`. */
export interface GitHubAppStatus {
  configured: boolean;
  owner: string | null;
  slug: string | null;
  installation_id: string | null;
  /**
   * New responses use `nango` or `none`.
   * The other values remain in this deprecated public type for compatibility.
   */
  source: 'nango' | 'db' | 'env' | 'pat' | 'none';
}

/** @deprecated Use `getManagedGitHubStatus`. */
export async function getGitHubAppStatus(): Promise<GitHubAppStatus> {
  return getManagedGitHubStatus();
}

/** @deprecated Managed GitHub setup uses Nango Connect. */
export interface GitHubAppManifestStartInput {
  /** GitHub org to own the new App; omit to create it under the caller's personal account. */
  org?: string;
}

export interface GitHubAppManifestStart {
  /** GitHub's manifest "create app" endpoint — POST a `manifest` field here to continue. */
  github_create_url: string;
  /** Opaque manifest body GitHub expects as the `manifest` form field, JSON-stringified. */
  manifest: Record<string, unknown>;
  /** CSRF-style state GitHub echoes back to manifest-callback; also appended as a query param here. */
  state: string;
}

/**
 * @deprecated Use `createManagedGitHubConnectSession`.
 *
 * This compatibility method rejects locally. It does not send the input.
 */
export async function startGitHubAppManifest(
  input: GitHubAppManifestStartInput = {},
): Promise<GitHubAppManifestStart> {
  void input;
  throw managedGitHubConnectionRequired();
}

export interface GitHubAppExistingInput {
  /** The App's numeric id, as shown on its GitHub settings page. */
  appId: string;
  /** The App's private key, PEM-encoded (real newlines or `\n`-escaped, either works). */
  privateKey: string;
  /** The id of this App's installation on the target account/org. */
  installationId: string;
  slug?: string;
}

/**
 * @deprecated Managed GitHub setup uses Nango Connect.
 *
 * This compatibility method rejects locally. It does not send the input.
 */
export async function setGitHubAppFromExisting(
  input: GitHubAppExistingInput,
): Promise<{ ok: true; owner: string }> {
  void input;
  throw managedGitHubConnectionRequired();
}

export interface GitHubAppPatInput {
  /** A dedicated fine-grained (or classic) personal access token — not an everyday personal token. */
  token: string;
  /** The GitHub user or org that owns the repos managed-git will create. */
  owner: string;
}

/**
 * @deprecated Managed GitHub setup uses Nango Connect.
 *
 * This compatibility method rejects locally. It does not send the input.
 */
export async function setGitHubAppPat(input: GitHubAppPatInput): Promise<{ ok: true }> {
  void input;
  throw managedGitHubConnectionRequired();
}

/** @deprecated Use `disconnectManagedGitHubConnection`. */
export async function disconnectGitHubApp(): Promise<{ ok: true }> {
  return disconnectManagedGitHubConnection();
}

function managedGitHubConnectionRequired(): ApiError {
  const details = {
    error: 'Legacy GitHub App setup is disabled.',
    code: 'github_connection_required',
    requires_human_oauth: true,
    sdk_action: 'createManagedGitHubConnectSession',
  } as const;
  return new ApiError(details.error, {
    status: 409,
    code: details.code,
    details,
    data: details,
  });
}

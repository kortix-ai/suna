/**
 * Platform API client — self-host GitHub App setup (manifest flow).
 *
 * Lets a self-host admin create + connect the platform's GitHub App entirely
 * from the web UI: POST manifest-start hands back a GitHub "create from
 * manifest" URL + the manifest body to submit; GET status reports whether a
 * GitHub App is configured (env-configured on cloud, or created via this
 * flow on self-host) without exposing secrets. The two browser-redirect
 * endpoints (manifest-callback, install-callback) are hit directly by GitHub
 * redirects — the frontend never calls them.
 */

import { backendApi } from '../../http/api-client';

export interface GitHubAppStatus {
  configured: boolean;
  owner: string | null;
  slug: string | null;
  installation_id: string | null;
  source: 'db' | 'env' | 'none';
}

/** Whether a GitHub App is configured for this platform, and (if so) which one. */
export async function getGitHubAppStatus(): Promise<GitHubAppStatus> {
  const response = await backendApi.get<GitHubAppStatus>('/platform/github-app/status', {
    showErrors: false,
  });
  if (response.error) throw response.error;
  if (!response.data) throw new Error('GitHub App status request failed');
  return response.data;
}

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
 * Start the GitHub App "manifest" creation flow. The caller must submit a
 * same-origin-free POST form to `${github_create_url}?state=${state}` with a
 * single hidden `manifest` field set to `JSON.stringify(manifest)` — GitHub
 * only accepts the manifest via POST, so this can't be a simple redirect.
 */
export async function startGitHubAppManifest(
  input: GitHubAppManifestStartInput = {},
): Promise<GitHubAppManifestStart> {
  const response = await backendApi.post<GitHubAppManifestStart>(
    '/platform/github-app/manifest-start',
    input,
    { showErrors: false },
  );
  if (response.error) throw response.error;
  if (!response.data) throw new Error('GitHub App manifest-start request failed');
  return response.data;
}

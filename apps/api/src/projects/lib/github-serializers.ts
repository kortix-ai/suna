import type { accountGithubInstallations } from '@kortix/db';
import { normalizeJsonObject } from '../../shared/json';
import { type GitHubRepo, isGithubAppConfigured } from '../github';
import { normalizeString } from './validators';

export function serializeGitHubRepo(repo: GitHubRepo) {
  return {
    id: String(repo.id),
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    html_url: repo.html_url,
    clone_url: repo.clone_url,
    ssh_url: repo.ssh_url,
    default_branch: repo.default_branch,
    description: repo.description,
  };
}

export function serializeGitHubInstallation(
  row: typeof accountGithubInstallations.$inferSelect | null,
  accountId: string,
  installUrl: string | null,
) {
  const installed = Boolean(row);
  const metadata = normalizeJsonObject(row?.metadata);
  // GitHub backing is App-only: a per-account App installation is required
  // whenever the App is configured and this account hasn't installed it yet.
  const requiresInstallation = isGithubAppConfigured() && !installed;
  return {
    account_id: accountId,
    installation_row_id: row?.installationRowId ?? null,
    installed,
    configured: isGithubAppConfigured(),
    requires_installation: requiresInstallation,
    install_url: installed ? null : installUrl,
    installation_id: row?.installationId ?? null,
    owner_login: row?.ownerLogin ?? null,
    owner_type: row?.ownerType ?? null,
    repository_selection: row?.repositorySelection ?? null,
    permissions: row?.permissions ?? {},
    installation_url: normalizeString(metadata.html_url),
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}

/**
 * Account connections only. The instance backend ("Kortix managed") used to
 * be injected here as a synthetic entry, which made one instance-global
 * credential look like this account's own GitHub connection.
 */
export function serializeGitHubInstallations(
  rows: Array<typeof accountGithubInstallations.$inferSelect>,
  accountId: string,
  installUrl: string | null,
) {
  const primary = rows[0] ?? null;
  const base = serializeGitHubInstallation(primary, accountId, installUrl);
  return {
    ...base,
    installed: rows.length > 0,
    requires_installation: isGithubAppConfigured() && rows.length === 0,
    install_url: installUrl,
    installations: rows.map((row) => serializeGitHubInstallation(row, accountId, null)),
  };
}

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  githubInstallationLabel,
  githubOwnerTypeLabel,
  isGitHubAppInstallationId,
  isUsableGitHubInstallation,
} from './github-installations';

describe('GitHub installation presentation', () => {
  test('separates real GitHub App installations from the managed PAT fallback', () => {
    expect(isGitHubAppInstallationId('123456')).toBe(true);
    expect(isGitHubAppInstallationId('pat')).toBe(false);
    expect(isGitHubAppInstallationId(null)).toBe(false);
  });

  test('labels the managed PAT fallback as a server connection', () => {
    expect(githubInstallationLabel('pat', 'kortixd')).toBe('Managed GitHub · github.com/kortixd');
    expect(githubInstallationLabel('123456', 'acme')).toBe('github.com/acme');
  });

  test('distinguishes personal and organization owners', () => {
    expect(githubInstallationLabel('123456', 'octocat', 'User')).toBe(
      'Personal · github.com/octocat',
    );
    expect(githubInstallationLabel('654321', 'acme', 'Organization')).toBe(
      'Organization · github.com/acme',
    );
    expect(githubOwnerTypeLabel('User')).toBe('Personal');
    expect(githubOwnerTypeLabel('Organization')).toBe('Organization');
    expect(githubOwnerTypeLabel(null)).toBeNull();
  });

  test('keeps reconnect and disconnected rows out of repository pickers', () => {
    expect(isUsableGitHubInstallation({ installed: true, connection_status: 'connected' })).toBe(
      true,
    );
    expect(isUsableGitHubInstallation({ installed: true, connection_status: null })).toBe(true);
    expect(
      isUsableGitHubInstallation({ installed: true, connection_status: 'needs_reconnect' }),
    ).toBe(false);
    expect(
      isUsableGitHubInstallation({ installed: false, connection_status: 'disconnected' }),
    ).toBe(false);
  });
});

describe('GitHub account connection surfaces', () => {
  const projectModalSource = readFileSync(
    join(import.meta.dir, '../features/projects/modal/project-create-modal.tsx'),
    'utf8',
  );
  const accountPageSource = readFileSync(
    join(import.meta.dir, '../app/(app)/accounts/[id]/page.tsx'),
    'utf8',
  );

  test('opens Nango Connect in place during repository import', () => {
    expect(projectModalSource).toContain('aria-label="Connect another GitHub account"');
    expect(projectModalSource).toContain('useGitHubNangoConnect');
    expect(projectModalSource).toContain('githubConnect.start()');
    expect(projectModalSource).not.toContain('router.push(`/github/setup?account_id=');
    expect(projectModalSource).not.toContain('github_user_token');
  });

  test('presents the three repository sources as one visible decision', () => {
    expect(projectModalSource).toContain('aria-label="Repository source"');
    expect(projectModalSource).toContain('Kortix managed');
    expect(projectModalSource).toContain('Create in GitHub');
    expect(projectModalSource).toContain('Import from GitHub');
    expect(projectModalSource).not.toContain('Use managed repository');
  });

  test('uses Nango lifecycle routes from account settings', () => {
    expect(accountPageSource).not.toContain("githubAppStatusQuery.data?.source === 'env'");
    expect(accountPageSource).toContain('useGitHubNangoConnect');
    expect(accountPageSource).toContain('disconnectGitHubConnection');
    expect(accountPageSource).toContain('githubConnect.start(installationId)');
    expect(accountPageSource).not.toContain('deleteGitHubInstallation');
    expect(accountPageSource).not.toContain('router.push(`/github/setup?account_id=');
    expect(accountPageSource).toContain('serverGitHubConfigured');
    expect(accountPageSource).toContain('GitHub is not configured on this server');
    expect(accountPageSource).toContain(
      '<GitHubConnectionCard account={account} canManage={canWriteAccount} />',
    );
  });
});

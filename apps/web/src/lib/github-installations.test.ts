import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { githubInstallationLabel, isGitHubAppInstallationId } from './github-installations';

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
});

describe('GitHub account connection surfaces', () => {
  // The two tests that used to live here (`keeps the GitHub App install
  // action visible during repository import`, `presents the three repository
  // sources as one visible decision`) asserted on
  // `project-create-modal.tsx`'s source. That modal — and the
  // `github-create`/`github-import` repository-source picker it alone drove —
  // was deleted along with it; `/new` only drives `POST /projects/provision`
  // (Kortix-managed repos). There is no surviving surface for either
  // assertion to move to, so they are gone, not adapted. The remaining test
  // below is independent of the deleted file.
  const accountPageSource = readFileSync(
    join(import.meta.dir, '../app/(app)/accounts/[id]/page.tsx'),
    'utf8',
  );

  test('does not gate account GitHub connections on managed-server status', () => {
    expect(accountPageSource).not.toContain("githubAppStatusQuery.data?.source === 'env'");
    expect(accountPageSource).toContain(
      '<GitHubConnectionCard account={account} canManage={canWriteAccount} />',
    );
  });
});

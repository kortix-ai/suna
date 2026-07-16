/**
 * Regression coverage for the self-host "Use a token" import bug: an account
 * whose ONLY managed-git connection is a PAT (platform/routes/github-app.ts
 * POST /pat) has no `account_github_installations` row and
 * `isGithubAppConfigured()` (App-only, appId+privateKey) is false — so
 * `GET /projects/github/installations` used to report `configured: false` /
 * zero installations, and the web Import-repo + New-project UI showed
 * "GitHub isn't connected on this server yet" even though managed-git
 * provisioning (POST /projects/provision) worked fine off the same PAT.
 *
 * `serializeGitHubInstallations` (projects/lib/serializers.ts) now takes an
 * optional PAT-fallback owner and synthesizes a connected "installation" for
 * it — see the matching route wiring in routes/r1.ts (GET
 * github/installation(s)) and routes/github-repositories.ts /
 * routes/r2.ts (POST /link-repository), which both recognize the sentinel
 * `PAT_MANAGED_GIT_INSTALLATION_ID` this produces.
 *
 * Pure-function test, no DB/module mocking needed — same convention as
 * unit-api-contract-serializers.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import type { accountGithubInstallations } from '@kortix/db';
import {
  PAT_MANAGED_GIT_INSTALLATION_ID,
  serializeGitHubInstallations,
} from '../projects/lib/serializers';

const ACCOUNT_ID = '99999999-8888-4777-8666-555555555555';

function installationRow(
  overrides: Partial<typeof accountGithubInstallations.$inferSelect> = {},
): typeof accountGithubInstallations.$inferSelect {
  return {
    installationRowId: '11111111-2222-4333-8444-555555555555',
    accountId: ACCOUNT_ID,
    installationId: '501',
    ownerLogin: 'acme-corp',
    ownerType: 'Organization',
    repositorySelection: 'all',
    permissions: {},
    metadata: {},
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('serializeGitHubInstallations — PAT fallback for the "Use a token" self-host setup', () => {
  test('no App installation, no PAT fallback owner -> stays not-connected (pre-existing behavior)', () => {
    const result = serializeGitHubInstallations([], ACCOUNT_ID, null, null);
    expect(result.installed).toBe(false);
    expect(result.installations).toEqual([]);
  });

  test('no App installation, PAT fallback owner given -> synthesizes a connected installation', () => {
    const result = serializeGitHubInstallations([], ACCOUNT_ID, null, 'Essentia-Innovation');

    expect(result.installed).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.requires_installation).toBe(false);
    expect(result.installation_id).toBe(PAT_MANAGED_GIT_INSTALLATION_ID);
    expect(result.owner_login).toBe('Essentia-Innovation');
    expect(result.installations).toEqual([
      expect.objectContaining({
        installation_id: PAT_MANAGED_GIT_INSTALLATION_ID,
        owner_login: 'Essentia-Innovation',
        installed: true,
        configured: true,
      }),
    ]);
  });

  test('a real App installation row wins — the PAT fallback is ignored, no duplicate/synthetic entry', () => {
    const row = installationRow();
    const result = serializeGitHubInstallations([row], ACCOUNT_ID, null, 'Essentia-Innovation');

    expect(result.installed).toBe(true);
    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]!.installation_id).toBe('501');
    expect(result.installations[0]!.owner_login).toBe('acme-corp');
  });
});

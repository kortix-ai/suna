import { describe, expect, test } from 'bun:test';
import type { accountGithubInstallations } from '@kortix/db';
import { serializeGitHubInstallations } from '../projects/lib/serializers';

const ACCOUNT_ID = '99999999-8888-4777-8666-555555555555';

function installationRow(
  overrides: Partial<typeof accountGithubInstallations.$inferSelect> = {},
): typeof accountGithubInstallations.$inferSelect {
  return {
    installationRowId: '11111111-2222-4333-8444-555555555555',
    accountId: ACCOUNT_ID,
    installationId: '501',
    nangoConnectionId: null,
    nangoIntegrationId: null,
    connectionStatus: null,
    lastValidatedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    disconnectedAt: null,
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

describe('serializeGitHubInstallations after the Nango-only cutover', () => {
  test('does not synthesize a PAT installation for an empty account', () => {
    const result = serializeGitHubInstallations([], ACCOUNT_ID, null);
    expect(result.installed).toBe(false);
    expect(result.installations).toEqual([]);
  });

  test('preserves a legacy installation only as reconnect metadata', () => {
    const row = installationRow({
      connectionStatus: 'needs_reconnect',
      lastErrorCode: 'github_reconnect_required',
    });
    const result = serializeGitHubInstallations([row], ACCOUNT_ID, null);

    expect(result.installed).toBe(true);
    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]!.installation_id).toBe('501');
    expect(result.installations[0]!.owner_login).toBe('acme-corp');
    expect(result.installations[0]!.reconnect_required).toBe(true);
  });
});

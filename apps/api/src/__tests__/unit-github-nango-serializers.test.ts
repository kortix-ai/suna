import { describe, expect, test } from 'bun:test';
import type { accountGithubInstallations } from '@kortix/db';
import {
  serializeGitHubInstallation,
  serializeGitHubInstallations,
} from '../projects/lib/serializers';

type InstallationRow = typeof accountGithubInstallations.$inferSelect;

function installationRow(overrides: Partial<InstallationRow> = {}): InstallationRow {
  const now = new Date('2026-07-27T17:00:00.000Z');
  return {
    installationRowId: '00000000-0000-4000-a000-000000000041',
    accountId: '00000000-0000-4000-a000-000000000101',
    installationId: '84',
    nangoConnectionId: 'nango-connection-1',
    nangoIntegrationId: 'github-account',
    connectionStatus: 'connected',
    lastValidatedAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    disconnectedAt: null,
    ownerLogin: 'acme',
    ownerType: 'Organization',
    repositorySelection: 'all',
    permissions: { contents: 'write' },
    metadata: {
      html_url: 'https://github.com/organizations/acme/settings/installations/84',
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('GitHub Nango installation serialization', () => {
  test('preserves legacy fields and adds credential-free connection health', () => {
    const result = serializeGitHubInstallation(
      installationRow(),
      '00000000-0000-4000-a000-000000000101',
      null,
    );

    expect(result).toMatchObject({
      installation_id: '84',
      owner_login: 'acme',
      owner_type: 'Organization',
      repository_selection: 'all',
      permissions: { contents: 'write' },
      installation_url: 'https://github.com/organizations/acme/settings/installations/84',
      connection_id: 'nango-connection-1',
      connection_provider: 'nango',
      connection_status: 'connected',
      reconnect_required: false,
    });
    expect(JSON.stringify(result)).not.toContain('token');
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  test('marks disconnected and unhealthy Nango installations for reconnect', () => {
    const result = serializeGitHubInstallation(
      installationRow({
        connectionStatus: 'disconnected',
        disconnectedAt: new Date('2026-07-27T17:30:00.000Z'),
      }),
      '00000000-0000-4000-a000-000000000101',
      null,
    );

    expect(result).toMatchObject({
      connection_status: 'disconnected',
      reconnect_required: true,
      installed: false,
    });
  });

  test('does not report a disconnected-only installation list as installed', () => {
    const result = serializeGitHubInstallations(
      [
        installationRow({
          connectionStatus: 'disconnected',
          disconnectedAt: new Date('2026-07-27T17:30:00.000Z'),
        }),
      ],
      '00000000-0000-4000-a000-000000000101',
      null,
    );

    expect(result).toMatchObject({
      installed: false,
      requires_installation: false,
      connection_status: 'disconnected',
      reconnect_required: true,
    });
    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]).toMatchObject({
      installed: false,
      connection_status: 'disconnected',
      reconnect_required: true,
    });
  });
});

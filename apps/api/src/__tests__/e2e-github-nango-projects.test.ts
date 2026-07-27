import { describe, expect, test } from 'bun:test';
import type { accountGithubInstallations } from '@kortix/db';

import {
  GitHubCredentialResolutionError,
  resolveAccountGithubCredential,
} from '../projects/nango/account-credential';
import type { NangoConnection } from '../projects/nango/client';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const INSTALLATION_ID = '73101';
const CONNECTION_ID = 'account-connection-73101';
const INTEGRATION_ID = 'github-app-oauth';

function installationRow(
  overrides: Partial<typeof accountGithubInstallations.$inferSelect> = {},
): typeof accountGithubInstallations.$inferSelect {
  return {
    installationRowId: '44444444-4444-4444-8444-444444444444',
    accountId: ACCOUNT_ID,
    installationId: INSTALLATION_ID,
    nangoConnectionId: CONNECTION_ID,
    nangoIntegrationId: INTEGRATION_ID,
    connectionStatus: 'connected',
    lastValidatedAt: new Date('2026-07-27T12:00:00.000Z'),
    lastErrorCode: null,
    lastErrorMessage: null,
    disconnectedAt: null,
    ownerLogin: 'acme',
    ownerType: 'Organization',
    repositorySelection: 'all',
    permissions: { contents: 'write' },
    metadata: {},
    createdAt: new Date('2026-07-27T12:00:00.000Z'),
    updatedAt: new Date('2026-07-27T12:00:00.000Z'),
    ...overrides,
  };
}

function nangoConnection(overrides: Partial<NangoConnection> = {}): NangoConnection {
  return {
    connectionId: CONNECTION_ID,
    integrationId: INTEGRATION_ID,
    provider: 'github-app-oauth',
    errors: [],
    metadata: {},
    connectionConfig: { installation_id: INSTALLATION_ID },
    tags: {
      kortix_account_id: ACCOUNT_ID,
      kortix_user_id: USER_ID,
      kortix_purpose: 'account',
      kortix_display_name: 'Acme',
      kortix_connect_attempt_id: '55555555-5555-4555-8555-555555555555',
    },
    credentials: {
      type: 'CUSTOM',
      app: {
        type: 'APP',
        access_token: 'installation-token',
        raw: {
          permissions: { contents: 'write' },
          repository_selection: 'all',
        },
      },
      user: {
        type: 'OAUTH2',
        access_token: 'user-token',
        raw: {},
      },
      raw: {},
    },
    ...overrides,
  };
}

describe('account GitHub Nango credential resolution', () => {
  test('resolves a fresh account-bound user credential without exposing it in metadata', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const result = await resolveAccountGithubCredential(
      { accountId: ACCOUNT_ID, installationId: INSTALLATION_ID },
      {
        accountIntegrationId: INTEGRATION_ID,
        getInstallation: async (accountId, installationId) => {
          expect(accountId).toBe(ACCOUNT_ID);
          expect(installationId).toBe(INSTALLATION_ID);
          return installationRow();
        },
        getConnection: async (input) => {
          requests.push(input);
          return nangoConnection();
        },
      },
    );

    expect(requests).toEqual([
      {
        connectionId: CONNECTION_ID,
        integrationId: INTEGRATION_ID,
        forceRefresh: true,
        refreshGithubAppJwtToken: true,
      },
    ]);
    expect(result.installation.accountId).toBe(ACCOUNT_ID);
    expect(result.credential.userToken).toBe('user-token');
    expect(result.credential.installationToken).toBe('installation-token');
    expect(JSON.stringify(result.installation)).not.toContain('user-token');
    expect(JSON.stringify(result.installation)).not.toContain('installation-token');
  });

  test('does not resolve a connection owned by another Kortix account', async () => {
    let nangoCalls = 0;

    await expect(
      resolveAccountGithubCredential(
        { accountId: OTHER_ACCOUNT_ID, installationId: INSTALLATION_ID },
        {
          accountIntegrationId: INTEGRATION_ID,
          getInstallation: async () => null,
          getConnection: async () => {
            nangoCalls += 1;
            return nangoConnection();
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'github_connection_required',
      status: 409,
      accountId: OTHER_ACCOUNT_ID,
      installationId: INSTALLATION_ID,
    });
    expect(nangoCalls).toBe(0);
  });

  test('returns reconnect guidance before Nango access for an unhealthy row', async () => {
    let nangoCalls = 0;

    await expect(
      resolveAccountGithubCredential(
        { accountId: ACCOUNT_ID, installationId: INSTALLATION_ID },
        {
          accountIntegrationId: INTEGRATION_ID,
          getInstallation: async () => installationRow({ connectionStatus: 'needs_reconnect' }),
          getConnection: async () => {
            nangoCalls += 1;
            return nangoConnection();
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'github_reconnect_required',
      status: 409,
    });
    expect(nangoCalls).toBe(0);
  });

  test('rejects mismatched Nango ownership and installation identities', async () => {
    await expect(
      resolveAccountGithubCredential(
        { accountId: ACCOUNT_ID, installationId: INSTALLATION_ID },
        {
          accountIntegrationId: INTEGRATION_ID,
          getInstallation: async () => installationRow(),
          getConnection: async () =>
            nangoConnection({
              tags: {
                ...nangoConnection().tags,
                kortix_account_id: OTHER_ACCOUNT_ID,
              },
            }),
        },
      ),
    ).rejects.toMatchObject({
      code: 'github_provider_failed',
      status: 502,
    });

    await expect(
      resolveAccountGithubCredential(
        { accountId: ACCOUNT_ID, installationId: INSTALLATION_ID },
        {
          accountIntegrationId: INTEGRATION_ID,
          getInstallation: async () => installationRow(),
          getConnection: async () =>
            nangoConnection({
              connectionConfig: { installation_id: '99999' },
            }),
        },
      ),
    ).rejects.toMatchObject({
      code: 'github_provider_failed',
      status: 502,
    });
  });
});

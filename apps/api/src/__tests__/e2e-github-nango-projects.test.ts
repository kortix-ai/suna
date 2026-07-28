import { describe, expect, test } from 'bun:test';
import type { accountGithubInstallations } from '@kortix/db';

import {
  GitHubCredentialResolutionError,
  resolveAccountGithubCredential,
  withFreshAccountGithubRead,
} from '../projects/nango/account-credential';
import type { NangoConnection } from '../projects/nango/client';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const INSTALLATION_ID = '73101';
const CONNECTION_ID = 'account-connection-73101';
const INTEGRATION_ID = 'github-app-oauth';

type ProjectNangoGitResolver = (
  input: {
    project: {
      projectId: string;
      accountId: string;
      repoUrl: string;
    };
    remote: {
      provider: string;
      authMethod: string;
      ref: string | null;
      installationId: string | null;
      repoOwner: string | null;
      repoName: string | null;
      managed?: boolean;
    };
    mode: 'nango_preferred' | 'nango_only';
  },
  dependencies: {
    resolveAccountCredential(input: {
      accountId: string;
      installationId: string;
    }): Promise<{
      installation: typeof accountGithubInstallations.$inferSelect;
      credential: {
        connectionId: string;
        installationId: string;
        installationToken: string;
      };
    }>;
    resolveManagedCredential?(): Promise<{
      setting: {
        connectionId: string;
        installationId: string;
        owner: { login: string; type: 'Organization' };
      };
      credential: {
        connectionId: string;
        installationId: string;
        installationToken: string;
      };
    }>;
  },
) => Promise<{
  auth: {
    token: string;
    source: 'nango';
    owner?: string;
    ownerType?: 'User' | 'Organization';
    installationId?: string;
  };
  authSource: 'nango';
} | null>;

type ProjectGitAccessResolver = (
  projectId: string,
  dependencies: {
    getProject(projectId: string): Promise<Record<string, unknown> | null>;
    resolveProject(project: Record<string, unknown>): Promise<{
      repoUrl: string;
      gitAuthToken: string | null;
      gitAuthHeaders: Record<string, string>;
    }>;
  },
) => Promise<{
  repoUrl: string;
  token: string | null;
  headers: Record<string, string>;
} | null>;

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

  test('re-resolves once after a 401 from an idempotent GitHub read', async () => {
    const tokens = ['stale-token', 'fresh-token'];
    let resolutionCalls = 0;
    const operationTokens: string[] = [];

    const result = await withFreshAccountGithubRead(
      { accountId: ACCOUNT_ID, installationId: INSTALLATION_ID },
      async ({ credential }) => {
        operationTokens.push(credential.userToken);
        if (credential.userToken === 'stale-token') {
          throw Object.assign(new Error('Bad credentials'), { status: 401 });
        }
        return 'ok';
      },
      {
        resolveCredential: async () => {
          const token = tokens[resolutionCalls] as string;
          resolutionCalls += 1;
          return {
            installation: installationRow(),
            credential: {
              mode: 'account',
              connectionId: CONNECTION_ID,
              integrationId: INTEGRATION_ID,
              installationId: INSTALLATION_ID,
              userToken: token,
              installationToken: 'installation-token',
              permissions: {},
              tags: {},
            },
          };
        },
      },
    );

    expect(result).toBe('ok');
    expect(resolutionCalls).toBe(2);
    expect(operationTokens).toEqual(['stale-token', 'fresh-token']);
  });

  test('does not retry a failed idempotent read more than once', async () => {
    let resolutionCalls = 0;
    let operationCalls = 0;
    const unauthorized = Object.assign(new Error('Bad credentials'), { status: 401 });

    await expect(
      withFreshAccountGithubRead(
        { accountId: ACCOUNT_ID, installationId: INSTALLATION_ID },
        async () => {
          operationCalls += 1;
          throw unauthorized;
        },
        {
          resolveCredential: async () => {
            resolutionCalls += 1;
            return {
              installation: installationRow(),
              credential: {
                mode: 'account',
                connectionId: CONNECTION_ID,
                integrationId: INTEGRATION_ID,
                installationId: INSTALLATION_ID,
                userToken: `token-${resolutionCalls}`,
                installationToken: 'installation-token',
                permissions: {},
                tags: {},
              },
            };
          },
        },
      ),
    ).rejects.toBe(unauthorized);
    expect(resolutionCalls).toBe(2);
    expect(operationCalls).toBe(2);
  });
});

describe('project runtime GitHub Nango credential resolution', () => {
  const project = {
    projectId: '66666666-6666-4666-8666-666666666666',
    accountId: ACCOUNT_ID,
    repoUrl: 'https://github.com/acme/demo.git',
  };
  const remote = {
    provider: 'github',
    authMethod: 'nango',
    ref: CONNECTION_ID,
    installationId: INSTALLATION_ID,
    repoOwner: 'acme',
    repoName: 'demo',
  };

  async function resolver(): Promise<ProjectNangoGitResolver> {
    const gitModule = await import('../projects/lib/git');
    const candidate = (
      gitModule as unknown as {
        resolveNangoProjectGitAuth?: ProjectNangoGitResolver;
      }
    ).resolveNangoProjectGitAuth;
    expect(typeof candidate).toBe('function');
    return candidate as ProjectNangoGitResolver;
  }

  test('uses the installation token at the runtime Git operation boundary', async () => {
    const calls: Array<{ accountId: string; installationId: string }> = [];
    const resolve = await resolver();
    const result = await resolve(
      { project, remote, mode: 'nango_preferred' },
      {
        resolveAccountCredential: async (input) => {
          calls.push(input);
          return {
            installation: installationRow(),
            credential: {
              connectionId: CONNECTION_ID,
              installationId: INSTALLATION_ID,
              installationToken: 'installation-token',
            },
          };
        },
      },
    );

    expect(calls).toEqual([{ accountId: ACCOUNT_ID, installationId: INSTALLATION_ID }]);
    expect(result).toEqual({
      auth: {
        token: 'installation-token',
        source: 'nango',
        owner: 'acme',
        ownerType: 'Organization',
        installationId: INSTALLATION_ID,
      },
      authSource: 'nango',
    });
    expect(JSON.stringify(result)).not.toContain('user-token');
  });

  test('uses the selected managed connection for managed project runtime Git', async () => {
    const resolve = await resolver();
    let accountCalls = 0;
    let managedCalls = 0;
    const result = await resolve(
      {
        project: {
          ...project,
          repoUrl: 'https://github.com/kortix-managed/demo.git',
        },
        remote: {
          ...remote,
          ref: 'managed-connection',
          repoOwner: 'kortix-managed',
          managed: true,
        },
        mode: 'nango_only',
      },
      {
        resolveAccountCredential: async () => {
          accountCalls += 1;
          throw new Error('account resolver must not run');
        },
        resolveManagedCredential: async () => {
          managedCalls += 1;
          return {
            setting: {
              connectionId: 'managed-connection',
              installationId: INSTALLATION_ID,
              owner: { login: 'kortix-managed', type: 'Organization' },
            },
            credential: {
              connectionId: 'managed-connection',
              installationId: INSTALLATION_ID,
              installationToken: 'managed-installation-token',
            },
          };
        },
      },
    );

    expect(accountCalls).toBe(0);
    expect(managedCalls).toBe(1);
    expect(result).toEqual({
      auth: {
        token: 'managed-installation-token',
        source: 'nango',
        owner: 'kortix-managed',
        ownerType: 'Organization',
        installationId: INSTALLATION_ID,
      },
      authSource: 'nango',
    });
  });

  test('rejects a project connection bound to another Nango connection', async () => {
    const resolve = await resolver();

    await expect(
      resolve(
        { project, remote, mode: 'nango_preferred' },
        {
          resolveAccountCredential: async () => ({
            installation: installationRow(),
            credential: {
              connectionId: 'different-connection',
              installationId: INSTALLATION_ID,
              installationToken: 'installation-token',
            },
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: 'github_reconnect_required',
      status: 409,
      accountId: ACCOUNT_ID,
      installationId: INSTALLATION_ID,
    });
  });

  test('allows legacy fallback only in nango_preferred mode', async () => {
    const resolve = await resolver();
    const legacyRemote = {
      ...remote,
      authMethod: 'github_app',
      ref: null,
    };
    let nangoCalls = 0;
    const dependencies = {
      resolveAccountCredential: async () => {
        nangoCalls += 1;
        return {
          installation: installationRow(),
          credential: {
            connectionId: CONNECTION_ID,
            installationId: INSTALLATION_ID,
            installationToken: 'installation-token',
          },
        };
      },
    };

    expect(
      await resolve({ project, remote: legacyRemote, mode: 'nango_preferred' }, dependencies),
    ).toBeNull();
    await expect(
      resolve({ project, remote: legacyRemote, mode: 'nango_only' }, dependencies),
    ).rejects.toMatchObject({
      code: 'github_reconnect_required',
      status: 409,
    });
    expect(nangoCalls).toBe(0);
  });

  test('propagates reconnect errors instead of returning anonymous Git access', async () => {
    const gitModule = await import('../projects/lib/git');
    const resolve = (
      gitModule as unknown as {
        resolveProjectGitAccessById: ProjectGitAccessResolver;
      }
    ).resolveProjectGitAccessById;
    const reconnectError = new GitHubCredentialResolutionError(
      'github_reconnect_required',
      409,
      ACCOUNT_ID,
      INSTALLATION_ID,
    );

    await expect(
      resolve(project.projectId, {
        getProject: async () => project,
        resolveProject: async () => {
          throw reconnectError;
        },
      }),
    ).rejects.toBe(reconnectError);
  });
});

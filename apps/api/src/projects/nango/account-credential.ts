import { accountGithubInstallations } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { type NangoClient, type NangoConnection, createNangoClient } from './client';
import { isNangoError } from './errors';
import {
  type AccountGithubCredential,
  decodeAccountGithubConnection,
  parseAccountNangoTags,
} from './github-connection';

type AccountGithubInstallation = typeof accountGithubInstallations.$inferSelect;

export type GitHubCredentialResolutionCode =
  | 'github_connection_required'
  | 'github_reconnect_required'
  | 'github_provider_failed';

export class GitHubCredentialResolutionError extends Error {
  constructor(
    readonly code: GitHubCredentialResolutionCode,
    readonly status: 409 | 502,
    readonly accountId: string,
    readonly installationId: string,
  ) {
    super(
      code === 'github_connection_required'
        ? 'A GitHub connection is required.'
        : code === 'github_reconnect_required'
          ? 'The GitHub connection must be reconnected.'
          : 'The GitHub credential broker returned an invalid response.',
    );
    this.name = 'GitHubCredentialResolutionError';
  }
}

export interface AccountGithubCredentialResolution {
  installation: AccountGithubInstallation;
  credential: AccountGithubCredential;
}

export interface AccountGithubCredentialDependencies {
  accountIntegrationId: string;
  getInstallation(
    accountId: string,
    installationId: string,
  ): Promise<AccountGithubInstallation | null>;
  getConnection(input: {
    connectionId: string;
    integrationId: string;
    forceRefresh: boolean;
    refreshGithubAppJwtToken: boolean;
  }): Promise<NangoConnection>;
}

let cachedClient: NangoClient | null = null;

async function productionDependencies(): Promise<AccountGithubCredentialDependencies> {
  const [{ config }, { db }] = await Promise.all([
    import('../../config'),
    import('../../shared/db'),
  ]);
  cachedClient ??= createNangoClient({
    apiKey: config.NANGO_API_KEY,
    baseUrl: config.NANGO_BASE_URL,
  });
  const client = cachedClient;
  return {
    accountIntegrationId: config.NANGO_GITHUB_ACCOUNT_INTEGRATION_ID,
    getInstallation: async (accountId, installationId) => {
      const [row] = await db
        .select()
        .from(accountGithubInstallations)
        .where(
          and(
            eq(accountGithubInstallations.accountId, accountId),
            eq(accountGithubInstallations.installationId, installationId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    getConnection: (input) => client.getConnection(input),
  };
}

function resolutionError(
  code: GitHubCredentialResolutionCode,
  accountId: string,
  installationId: string,
): GitHubCredentialResolutionError {
  return new GitHubCredentialResolutionError(
    code,
    code === 'github_provider_failed' ? 502 : 409,
    accountId,
    installationId,
  );
}

export async function resolveAccountGithubCredential(
  input: { accountId: string; installationId: string },
  dependencies?: AccountGithubCredentialDependencies,
): Promise<AccountGithubCredentialResolution> {
  const resolvedDependencies = dependencies ?? (await productionDependencies());
  const installation = await resolvedDependencies.getInstallation(
    input.accountId,
    input.installationId,
  );
  if (!installation) {
    throw resolutionError('github_connection_required', input.accountId, input.installationId);
  }

  if (
    installation.connectionStatus !== 'connected' ||
    !installation.nangoConnectionId ||
    !installation.nangoIntegrationId
  ) {
    throw resolutionError(
      installation.nangoConnectionId ? 'github_reconnect_required' : 'github_connection_required',
      input.accountId,
      input.installationId,
    );
  }

  if (
    !resolvedDependencies.accountIntegrationId ||
    installation.nangoIntegrationId !== resolvedDependencies.accountIntegrationId
  ) {
    throw resolutionError('github_provider_failed', input.accountId, input.installationId);
  }

  let connection: NangoConnection;
  try {
    connection = await resolvedDependencies.getConnection({
      connectionId: installation.nangoConnectionId,
      integrationId: installation.nangoIntegrationId,
      forceRefresh: true,
      refreshGithubAppJwtToken: true,
    });
  } catch (error) {
    if (isNangoError(error) && error.code === 'github_reconnect_required') {
      throw resolutionError('github_reconnect_required', input.accountId, input.installationId);
    }
    throw error;
  }

  let credential: AccountGithubCredential;
  try {
    credential = decodeAccountGithubConnection(connection, {
      integrationId: installation.nangoIntegrationId,
    });
  } catch {
    throw resolutionError('github_provider_failed', input.accountId, input.installationId);
  }

  const tags = parseAccountNangoTags(credential.tags);
  if (
    tags?.accountId !== input.accountId ||
    credential.connectionId !== installation.nangoConnectionId ||
    credential.installationId !== installation.installationId
  ) {
    throw resolutionError('github_provider_failed', input.accountId, input.installationId);
  }

  return { installation, credential };
}

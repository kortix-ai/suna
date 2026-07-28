import { accountGithubInstallations } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

import { type NangoClient, type NangoConnection, createNangoClient } from './client';
import { isNangoError } from './errors';
import {
  type AccountGithubCredential,
  decodeAccountGithubConnection,
  parseAccountNangoTags,
} from './github-connection';
import {
  createNangoRequestObserver,
  recordGithubCredentialState,
} from './telemetry';

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
  observeState?(observation: {
    state: 'connected' | 'needs_reconnect' | 'error' | 'disconnected' | 'missing';
    outcome: 'success' | 'error';
    errorCode?: string;
  }): void;
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
    observe: createNangoRequestObserver('account'),
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
    observeState: (observation) =>
      recordGithubCredentialState({ scope: 'account', ...observation }),
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
    resolvedDependencies.observeState?.({
      state: 'missing',
      outcome: 'error',
      errorCode: 'github_connection_required',
    });
    throw resolutionError('github_connection_required', input.accountId, input.installationId);
  }

  if (
    installation.connectionStatus !== 'connected' ||
    !installation.nangoConnectionId ||
    !installation.nangoIntegrationId
  ) {
    const errorCode = installation.nangoConnectionId
      ? 'github_reconnect_required'
      : 'github_connection_required';
    resolvedDependencies.observeState?.({
      state:
        installation.connectionStatus === 'disconnected'
          ? 'disconnected'
          : installation.nangoConnectionId
            ? 'needs_reconnect'
            : 'missing',
      outcome: 'error',
      errorCode,
    });
    throw resolutionError(
      errorCode,
      input.accountId,
      input.installationId,
    );
  }

  if (
    !resolvedDependencies.accountIntegrationId ||
    installation.nangoIntegrationId !== resolvedDependencies.accountIntegrationId
  ) {
    resolvedDependencies.observeState?.({
      state: 'error',
      outcome: 'error',
      errorCode: 'github_provider_failed',
    });
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
      resolvedDependencies.observeState?.({
        state: 'needs_reconnect',
        outcome: 'error',
        errorCode: 'github_reconnect_required',
      });
      throw resolutionError('github_reconnect_required', input.accountId, input.installationId);
    }
    resolvedDependencies.observeState?.({
      state: 'error',
      outcome: 'error',
      errorCode: isNangoError(error) ? error.code : 'nango_unavailable',
    });
    throw error;
  }

  let credential: AccountGithubCredential;
  try {
    credential = decodeAccountGithubConnection(connection, {
      integrationId: installation.nangoIntegrationId,
    });
  } catch {
    resolvedDependencies.observeState?.({
      state: 'error',
      outcome: 'error',
      errorCode: 'github_provider_failed',
    });
    throw resolutionError('github_provider_failed', input.accountId, input.installationId);
  }

  const tags = parseAccountNangoTags(credential.tags);
  if (
    tags?.accountId !== input.accountId ||
    credential.connectionId !== installation.nangoConnectionId ||
    credential.installationId !== installation.installationId
  ) {
    resolvedDependencies.observeState?.({
      state: 'error',
      outcome: 'error',
      errorCode: 'github_provider_failed',
    });
    throw resolutionError('github_provider_failed', input.accountId, input.installationId);
  }

  resolvedDependencies.observeState?.({ state: 'connected', outcome: 'success' });
  return { installation, credential };
}

export interface AccountGithubReadDependencies {
  resolveCredential(input: {
    accountId: string;
    installationId: string;
  }): Promise<AccountGithubCredentialResolution>;
}

function isGithubUnauthorized(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
}

/**
 * Run one idempotent GitHub read with a fresh Nango credential. A GitHub 401
 * triggers one forced Nango refresh and one replay. Other failures are not
 * replayed. Mutations and Git pack streams must not use this helper.
 */
export async function withFreshAccountGithubRead<T>(
  input: { accountId: string; installationId: string },
  operation: (resolution: AccountGithubCredentialResolution) => Promise<T>,
  dependencies: AccountGithubReadDependencies = {
    resolveCredential: resolveAccountGithubCredential,
  },
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolution = await dependencies.resolveCredential(input);
    try {
      return await operation(resolution);
    } catch (error) {
      if (attempt === 0 && isGithubUnauthorized(error)) continue;
      throw error;
    }
  }
  throw new Error('Unreachable GitHub credential refresh state');
}

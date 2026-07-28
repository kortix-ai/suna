import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GitHubAppInstallation } from '../../projects/github';
import type {
  NangoClient,
  NangoConnectSession,
  NangoConnection,
  NangoConnectionSummary,
} from '../../projects/nango/client';
import {
  githubInsufficientPermissions,
  githubReconnectRequired,
  invalidNangoResponse,
} from '../../projects/nango/errors';
import {
  type ManagedGithubCredential,
  buildManagedNangoTags,
  decodeManagedGithubConnection,
  parseManagedNangoTags,
} from '../../projects/nango/github-connection';
import {
  type ManagedNangoGithubSetting,
  managedNangoGithubSettingSchema,
} from './managed-nango-github';

const installationConfigSchema = z
  .object({
    installation_id: z.union([z.string().min(1), z.number().int().positive()]),
    jwtToken: z.string().min(1),
  })
  .passthrough();

export type ManagedGithubCandidateStatus = 'connected' | 'needs_reconnect' | 'error';

export interface ManagedGithubCandidate {
  connectionId: string;
  integrationId: string;
  displayName: string;
  installationId: string | null;
  owner: {
    login: string;
    type: 'Organization';
  } | null;
  status: ManagedGithubCandidateStatus;
  selected: boolean;
  repositorySelection?: string;
  permissions: Record<string, unknown>;
}

export interface ManagedGithubConnectionStatus {
  configured: boolean;
  selected: ManagedGithubCandidate | null;
  candidates: ManagedGithubCandidate[];
}

export interface ManagedGithubCredentialResolution {
  credential: ManagedGithubCredential;
  setting: ManagedNangoGithubSetting;
}

export interface ManagedGithubConnectionStore {
  getSelected(): Promise<ManagedNangoGithubSetting | null>;
  saveSelected(setting: ManagedNangoGithubSetting): Promise<void>;
  markManagedProjectsUnavailable(input: {
    connectionId: string;
    installationId: string;
  }): Promise<void>;
}

export interface ManagedGithubConnectionServiceDependencies {
  client: NangoClient;
  store: ManagedGithubConnectionStore;
  integrationId: string;
  environmentId: string;
  webhookUrlOverride?: string;
  createAttemptId(): string;
  now(): Date;
  getInstallation(input: {
    installationId: string;
    appJwt: string;
  }): Promise<GitHubAppInstallation>;
}

const requiredManagedGithubPermissions = [
  ['administration', 'write'],
  ['contents', 'write'],
  ['metadata', 'read'],
  ['pull_requests', 'write'],
] as const;

export function missingManagedGithubPermissions(
  permissions: Record<string, unknown>,
): string[] {
  return requiredManagedGithubPermissions.flatMap(([name, required]) => {
    const actual = permissions[name];
    const allowed =
      actual === 'write' || (required === 'read' && actual === 'read');
    return allowed ? [] : [name];
  });
}

function normalizeEnvironmentUrl(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function managedGithubEnvironmentId(environment: string, supabaseUrl: string): string {
  const digest = createHash('sha256')
    .update(`${environment.trim().toLowerCase()}\n${normalizeEnvironmentUrl(supabaseUrl)}`)
    .digest('hex')
    .slice(0, 32);
  return `kortix_${digest}`;
}

function connectionInstallationId(connection: NangoConnectionSummary): string | null {
  const value = connection.connectionConfig.installation_id;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function candidateStatus(connection: NangoConnectionSummary): ManagedGithubCandidateStatus {
  return connection.errors.some((error) => error.type === 'auth') ? 'needs_reconnect' : 'error';
}

function selectedOwner(
  selected: ManagedNangoGithubSetting | null,
  connectionId: string,
): ManagedGithubCandidate['owner'] {
  return selected?.connectionId === connectionId ? selected.owner : null;
}

export function createManagedGithubConnectionService(
  dependencies: ManagedGithubConnectionServiceDependencies,
) {
  const integrationId = dependencies.integrationId.trim();
  const environmentId = dependencies.environmentId.trim();
  if (!integrationId) throw new TypeError('Managed Nango integration ID is required.');
  if (!environmentId) throw new TypeError('Managed GitHub environment ID is required.');

  const tagsFor = (userId: string, displayName: string) => ({
    ...buildManagedNangoTags({
      selectedByUserId: userId,
      displayName,
      connectAttemptId: dependencies.createAttemptId(),
    }),
    kortix_environment_id: environmentId,
  });

  const isEnvironmentCandidate = (connection: NangoConnectionSummary): boolean => {
    const tags = parseManagedNangoTags(connection.tags);
    return (
      connection.integrationId === integrationId &&
      connection.provider === 'github-app' &&
      tags !== null &&
      connection.tags.kortix_environment_id === environmentId
    );
  };

  const listCandidateSummaries = async (): Promise<NangoConnectionSummary[]> => {
    const connections = await dependencies.client.listConnections({
      integrationId,
      tags: {
        kortix_purpose: 'managed',
        kortix_environment_id: environmentId,
      },
      limit: 100,
    });
    return connections.filter(isEnvironmentCandidate);
  };

  const inspectConnection = async (
    summary: NangoConnectionSummary,
    selected: ManagedNangoGithubSetting | null,
  ): Promise<ManagedGithubCandidate> => {
    const tags = parseManagedNangoTags(summary.tags);
    if (!tags || !isEnvironmentCandidate(summary)) throw invalidNangoResponse();

    if (summary.errors.length > 0) {
      return {
        connectionId: summary.connectionId,
        integrationId,
        displayName: tags.displayName,
        installationId: connectionInstallationId(summary),
        owner: selectedOwner(selected, summary.connectionId),
        status: candidateStatus(summary),
        selected: selected?.connectionId === summary.connectionId,
        permissions: {},
      };
    }

    try {
      const connection = await dependencies.client.getConnection({
        connectionId: summary.connectionId,
        integrationId,
        forceRefresh: true,
        refreshGithubAppJwtToken: true,
      });
      if (!isEnvironmentCandidate(connection)) throw invalidNangoResponse();

      const credential = decodeManagedGithubConnection(connection, { integrationId });
      const appConfig = installationConfigSchema.safeParse(connection.connectionConfig);
      if (!appConfig.success) throw invalidNangoResponse();
      if (String(appConfig.data.installation_id) !== credential.installationId) {
        throw invalidNangoResponse();
      }

      const installation = await dependencies.getInstallation({
        installationId: credential.installationId,
        appJwt: appConfig.data.jwtToken,
      });
      const ownerLogin = installation.account?.login?.trim();
      if (
        String(installation.id) !== credential.installationId ||
        installation.account?.type !== 'Organization' ||
        !ownerLogin
      ) {
        throw invalidNangoResponse();
      }
      const missingPermissions = missingManagedGithubPermissions(credential.permissions);

      return {
        connectionId: connection.connectionId,
        integrationId,
        displayName: tags.displayName,
        installationId: credential.installationId,
        owner: { login: ownerLogin, type: 'Organization' },
        status: missingPermissions.length === 0 ? 'connected' : 'error',
        selected: selected?.connectionId === connection.connectionId,
        ...(credential.repositorySelection
          ? { repositorySelection: credential.repositorySelection }
          : {}),
        permissions: credential.permissions,
      };
    } catch {
      return {
        connectionId: summary.connectionId,
        integrationId,
        displayName: tags.displayName,
        installationId: connectionInstallationId(summary),
        owner: selectedOwner(selected, summary.connectionId),
        status: candidateStatus(summary),
        selected: selected?.connectionId === summary.connectionId,
        permissions: {},
      };
    }
  };

  const findCandidate = async (connectionId: string): Promise<NangoConnectionSummary> => {
    const candidates = await listCandidateSummaries();
    const candidate = candidates.find((item) => item.connectionId === connectionId);
    if (!candidate) throw new Error('Managed GitHub candidate was not found.');
    return candidate;
  };

  const listCandidates = async (): Promise<ManagedGithubCandidate[]> => {
    const [selected, summaries] = await Promise.all([
      dependencies.store.getSelected(),
      listCandidateSummaries(),
    ]);
    return Promise.all(summaries.map((summary) => inspectConnection(summary, selected)));
  };

  const selectCandidate = async (
    connectionId: string,
    selectedByUserId: string,
  ): Promise<ManagedGithubCandidate> => {
    const summary = await findCandidate(connectionId);
    const candidate = await inspectConnection(summary, null);
    if (
      Object.keys(candidate.permissions).length > 0 &&
      missingManagedGithubPermissions(candidate.permissions).length > 0
    ) {
      throw githubInsufficientPermissions();
    }
    if (candidate.status !== 'connected' || !candidate.installationId || !candidate.owner) {
      throw githubReconnectRequired(401);
    }

    const setting = managedNangoGithubSettingSchema.parse({
      schemaVersion: 1,
      connectionId: candidate.connectionId,
      integrationId,
      installationId: candidate.installationId,
      owner: candidate.owner,
      status: 'connected',
      selectedByUserId,
      selectedAt: dependencies.now().toISOString(),
    });
    await dependencies.store.saveSelected(setting);
    return { ...candidate, selected: true };
  };

  const getStatus = async (): Promise<ManagedGithubConnectionStatus> => {
    const [selected, candidates] = await Promise.all([
      dependencies.store.getSelected(),
      listCandidates(),
    ]);
    if (!selected) return { configured: false, selected: null, candidates };

    const selectedCandidate = candidates.find(
      (candidate) => candidate.connectionId === selected.connectionId,
    );
    if (selectedCandidate) {
      return {
        configured: selectedCandidate.status === 'connected',
        selected: { ...selectedCandidate, selected: true },
        candidates,
      };
    }

    return {
      configured: false,
      selected: {
        connectionId: selected.connectionId,
        integrationId: selected.integrationId,
        displayName: selected.owner.login,
        installationId: selected.installationId,
        owner: selected.owner,
        status: selected.status === 'disconnected' ? 'needs_reconnect' : 'error',
        selected: true,
        permissions: {},
      },
      candidates,
    };
  };

  const createConnectSession = (selectedByUserId: string): Promise<NangoConnectSession> =>
    dependencies.client.createConnectSession({
      integrationId,
      tags: tagsFor(selectedByUserId, 'Kortix Managed GitHub'),
      ...(dependencies.webhookUrlOverride
        ? { webhookUrlOverride: dependencies.webhookUrlOverride }
        : {}),
    });

  const createReconnectSession = async (
    connectionId: string,
    selectedByUserId: string,
  ): Promise<NangoConnectSession> => {
    const candidate = await findCandidate(connectionId);
    const parsedTags = parseManagedNangoTags(candidate.tags);
    if (!parsedTags) throw new Error('Managed GitHub candidate was not found.');
    return dependencies.client.createReconnectSession({
      connectionId,
      integrationId,
      tags: tagsFor(selectedByUserId, parsedTags.displayName),
      ...(dependencies.webhookUrlOverride
        ? { webhookUrlOverride: dependencies.webhookUrlOverride }
        : {}),
    });
  };

  const disconnectSelected = async (): Promise<void> => {
    const selected = await dependencies.store.getSelected();
    if (!selected) throw new Error('No managed GitHub connection is selected.');

    await dependencies.client.deleteConnection({
      connectionId: selected.connectionId,
      integrationId: selected.integrationId,
    });
    await dependencies.store.markManagedProjectsUnavailable({
      connectionId: selected.connectionId,
      installationId: selected.installationId,
    });
    await dependencies.store.saveSelected(
      managedNangoGithubSettingSchema.parse({
        ...selected,
        status: 'disconnected',
      }),
    );
  };

  const resolveSelectedCredential = async (): Promise<ManagedGithubCredentialResolution> => {
    const selected = await dependencies.store.getSelected();
    if (!selected || selected.status === 'disconnected') throw githubReconnectRequired(404);

    const connection = await dependencies.client.getConnection({
      connectionId: selected.connectionId,
      integrationId: selected.integrationId,
      forceRefresh: true,
    });
    if (!isEnvironmentCandidate(connection)) throw invalidNangoResponse();
    const credential = decodeManagedGithubConnection(connection, {
      integrationId: selected.integrationId,
    });
    if (credential.installationId !== selected.installationId) throw invalidNangoResponse();
    if (missingManagedGithubPermissions(credential.permissions).length > 0) {
      throw githubInsufficientPermissions();
    }
    return { credential, setting: selected };
  };

  return {
    createConnectSession,
    createReconnectSession,
    listCandidates,
    selectCandidate,
    getStatus,
    disconnectSelected,
    resolveSelectedCredential,
  };
}

export type ManagedGithubConnectionService = ReturnType<
  typeof createManagedGithubConnectionService
>;

import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  NangoClient,
  NangoConnectSession,
  NangoConnection,
  NangoConnectionSummary,
} from '../../projects/nango/client';
import {
  type ManagedGithubConnectionStore,
  createManagedGithubConnectionService,
  managedGithubEnvironmentId,
} from './managed-github-connection';
import type { ManagedNangoGithubSetting } from './managed-nango-github';

const adminUserId = 'f5f875ba-e054-41ca-a441-6e032f969d88';
const integrationId = 'github-app';
const environmentId = managedGithubEnvironmentId('dev', 'https://example.supabase.co');

function managedTags(
  displayName: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    kortix_user_id: adminUserId,
    kortix_purpose: 'managed',
    kortix_display_name: displayName,
    kortix_connect_attempt_id: '436b7337-728f-487f-a7e8-306a8fa5ea30',
    kortix_environment_id: environmentId,
    ...overrides,
  };
}

function connection(
  connectionId: string,
  installationId: string,
  displayName: string,
  overrides: Partial<NangoConnection> = {},
): NangoConnection {
  return {
    connectionId,
    integrationId,
    provider: 'github-app',
    errors: [],
    metadata: {},
    connectionConfig: {
      installation_id: installationId,
      jwtToken: `app-jwt-${connectionId}`,
    },
    tags: managedTags(displayName),
    credentials: {
      type: 'APP',
      access_token: `installation-token-${connectionId}`,
      expires_at: '2026-07-27T22:00:00.000Z',
      raw: {
        permissions: {
          administration: 'write',
          contents: 'write',
          metadata: 'read',
          pull_requests: 'write',
        },
        repository_selection: 'all',
      },
    },
    ...overrides,
  };
}

function makeFixture() {
  let selected: ManagedNangoGithubSetting | null = null;
  const saved: ManagedNangoGithubSetting[] = [];
  const unavailable: Array<{ connectionId: string; installationId: string }> = [];
  const deleted: Array<{ connectionId: string; integrationId: string }> = [];
  const connectInputs: Parameters<NangoClient['createConnectSession']>[0][] = [];
  const reconnectInputs: Parameters<NangoClient['createReconnectSession']>[0][] = [];
  let connections: NangoConnection[] = [
    connection('managed-a', '101', 'Engineering'),
    connection('managed-b', '202', 'Product'),
  ];
  let getConnectionError: Error | null = null;

  const store: ManagedGithubConnectionStore = {
    getSelected: async () => selected,
    saveSelected: async (value) => {
      selected = value;
      saved.push(structuredClone(value));
    },
    markManagedProjectsUnavailable: async (input) => {
      unavailable.push(input);
    },
  };

  const session: NangoConnectSession = {
    token: 'connect-session-token',
    expiresAt: '2026-07-27T22:00:00.000Z',
    connectLink: 'https://connect.nango.dev/session',
  };

  const client: NangoClient = {
    createConnectSession: async (input) => {
      connectInputs.push(input);
      return session;
    },
    createReconnectSession: async (input) => {
      reconnectInputs.push(input);
      return session;
    },
    listConnections: async () =>
      connections.map(({ credentials: _credentials, ...summary }) => summary),
    getConnection: async ({ connectionId }) => {
      if (getConnectionError) throw getConnectionError;
      const match = connections.find((item) => item.connectionId === connectionId);
      if (!match) throw new Error('missing connection');
      return match;
    },
    deleteConnection: async (input) => {
      deleted.push(input);
    },
  };

  const service = createManagedGithubConnectionService({
    client,
    store,
    integrationId,
    environmentId,
    webhookUrlOverride: 'https://local.example.test/v1/webhooks/nango',
    createAttemptId: () => '436b7337-728f-487f-a7e8-306a8fa5ea30',
    now: () => new Date('2026-07-27T21:00:00.000Z'),
    getInstallation: async ({ installationId }) => ({
      id: Number(installationId),
      account: {
        login: installationId === '101' ? 'kortix-engineering' : 'kortix-product',
        type: 'Organization',
      },
      repository_selection: 'all',
      permissions: {
        administration: 'write',
        contents: 'write',
        metadata: 'read',
        pull_requests: 'write',
      },
    }),
  });

  return {
    service,
    saved,
    unavailable,
    deleted,
    connectInputs,
    reconnectInputs,
    setConnections(next: NangoConnection[]) {
      connections = next;
    },
    setSelected(next: ManagedNangoGithubSetting | null) {
      selected = next;
    },
    setGetConnectionError(error: Error | null) {
      getConnectionError = error;
    },
  };
}

describe('managedGithubEnvironmentId', () => {
  test('is stable and does not expose the Supabase URL', () => {
    const first = managedGithubEnvironmentId('dev', 'https://example.supabase.co/');
    const second = managedGithubEnvironmentId('dev', 'https://example.supabase.co');

    expect(first).toBe(second);
    expect(first).toMatch(/^kortix_[a-f0-9]{32}$/);
    expect(first).not.toContain('example.supabase.co');
    expect(managedGithubEnvironmentId('prod', 'https://example.supabase.co')).not.toBe(first);
  });
});

describe('managed GitHub Nango connection lifecycle', () => {
  let fixture: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fixture = makeFixture();
  });

  test('creates an environment-tagged managed Connect session', async () => {
    const result = await fixture.service.createConnectSession(adminUserId);

    expect(result.connectLink).toBe('https://connect.nango.dev/session');
    expect(fixture.connectInputs).toEqual([
      {
        integrationId,
        tags: managedTags('Kortix Managed GitHub'),
        webhookUrlOverride: 'https://local.example.test/v1/webhooks/nango',
      },
    ]);
  });

  test('lists two matching candidates separately without selecting either one', async () => {
    fixture.setConnections([
      connection('managed-a', '101', 'Engineering'),
      connection('foreign', '303', 'Foreign', {
        tags: managedTags('Foreign', { kortix_environment_id: 'kortix_foreign' }),
      }),
      connection('managed-b', '202', 'Product'),
    ]);

    const result = await fixture.service.listCandidates();

    expect(result).toHaveLength(2);
    expect(result.map((candidate) => candidate.connectionId)).toEqual(['managed-a', 'managed-b']);
    expect(result.every((candidate) => candidate.selected === false)).toBe(true);
    expect(fixture.saved).toEqual([]);
  });

  test('persists only identifiers and installation metadata after explicit selection', async () => {
    const selected = await fixture.service.selectCandidate('managed-b', adminUserId);

    expect(selected.selected).toBe(true);
    expect(selected.owner).toEqual({ login: 'kortix-product', type: 'Organization' });
    expect(fixture.saved).toEqual([
      {
        schemaVersion: 1,
        connectionId: 'managed-b',
        integrationId,
        installationId: '202',
        owner: { login: 'kortix-product', type: 'Organization' },
        status: 'connected',
        selectedByUserId: adminUserId,
        selectedAt: '2026-07-27T21:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(fixture.saved)).not.toContain('token');
    expect(JSON.stringify(fixture.saved)).not.toContain('jwt');
  });

  test('reports configured only while the explicitly selected credential validates', async () => {
    await fixture.service.selectCandidate('managed-a', adminUserId);
    expect((await fixture.service.getStatus()).configured).toBe(true);

    fixture.setGetConnectionError(new Error('credential unavailable'));
    const status = await fixture.service.getStatus();

    expect(status.configured).toBe(false);
    expect(status.selected?.status).toBe('error');
  });

  test('rejects a candidate that cannot write repository contents or pull requests', async () => {
    fixture.setConnections([
      connection('managed-read-only', '101', 'Read only', {
        credentials: {
          type: 'APP',
          access_token: 'installation-token-read-only',
          raw: {
            permissions: {
              administration: 'write',
              contents: 'read',
              metadata: 'read',
            },
            repository_selection: 'all',
          },
        },
      }),
    ]);

    const [candidate] = await fixture.service.listCandidates();

    expect(candidate).toMatchObject({
      connectionId: 'managed-read-only',
      status: 'error',
      permissions: {
        administration: 'write',
        contents: 'read',
        metadata: 'read',
      },
    });
    await expect(
      fixture.service.selectCandidate('managed-read-only', adminUserId),
    ).rejects.toMatchObject({
      code: 'github_insufficient_permissions',
      status: 403,
    });

    fixture.setSelected({
      schemaVersion: 1,
      connectionId: 'managed-read-only',
      integrationId,
      installationId: '101',
      owner: { login: 'kortix-engineering', type: 'Organization' },
      status: 'connected',
      selectedByUserId: adminUserId,
      selectedAt: '2026-07-27T21:00:00.000Z',
    });
    await expect(fixture.service.resolveSelectedCredential()).rejects.toMatchObject({
      code: 'github_insufficient_permissions',
      status: 403,
    });
  });

  test('reconnects the requested candidate with the same connection ID', async () => {
    await fixture.service.createReconnectSession('managed-b', adminUserId);

    expect(fixture.reconnectInputs).toEqual([
      {
        connectionId: 'managed-b',
        integrationId,
        tags: managedTags('Product'),
        webhookUrlOverride: 'https://local.example.test/v1/webhooks/nango',
      },
    ]);
  });

  test('disconnect revokes Nango and marks managed projects unavailable without a repository delete', async () => {
    await fixture.service.selectCandidate('managed-a', adminUserId);
    await fixture.service.disconnectSelected();

    expect(fixture.deleted).toEqual([{ connectionId: 'managed-a', integrationId }]);
    expect(fixture.unavailable).toEqual([{ connectionId: 'managed-a', installationId: '101' }]);
    expect(fixture.saved.at(-1)?.status).toBe('disconnected');
  });

  test('rejects a candidate from another environment even when Nango returns it directly', async () => {
    fixture.setConnections([
      connection('foreign', '303', 'Foreign', {
        tags: managedTags('Foreign', { kortix_environment_id: 'kortix_foreign' }),
      }),
    ]);

    await expect(fixture.service.selectCandidate('foreign', adminUserId)).rejects.toThrow(
      'Managed GitHub candidate was not found.',
    );
    expect(fixture.saved).toEqual([]);
  });
});

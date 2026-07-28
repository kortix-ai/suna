import { describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { accountGithubInstallations, projectGitConnections } from '@kortix/db';
import type { ManagedGithubConnectionStore } from '../platform/services/managed-github-connection';
import type { NangoConnection, NangoConnectionSummary } from '../projects/nango/client';
import { NangoError } from '../projects/nango/errors';
import {
  type GithubInstallationMetadata,
  buildAccountNangoTags,
  buildManagedNangoTags,
} from '../projects/nango/github-connection';
import type { NangoGithubConnectionStore } from '../webhooks/nango';

let databaseSelectResults: unknown[][] = [];
let databaseReturningResults: unknown[][] = [];
const databaseInserts: Array<{
  table: unknown;
  values: unknown;
  conflict: unknown;
}> = [];
const databaseUpdates: Array<{
  table: unknown;
  values: unknown;
  where: unknown;
}> = [];

const fakeDatabaseOperations = {
  select: () => ({
    from: (_table: unknown) => ({
      where: (_where: unknown) => ({
        limit: async (_limit: number) => databaseSelectResults.shift() ?? [],
      }),
    }),
  }),
  insert: (table: unknown) => ({
    values: (values: unknown) => ({
      onConflictDoUpdate: async (conflict: unknown) => {
        databaseInserts.push({ table, values, conflict });
        return [];
      },
    }),
  }),
  update: (table: unknown) => ({
    set: (values: unknown) => ({
      where: (where: unknown) => {
        databaseUpdates.push({ table, values, where });
        return Object.assign(Promise.resolve([]), {
          returning: async () => databaseReturningResults.shift() ?? [],
        });
      },
    }),
  }),
};
const fakeDatabase = {
  ...fakeDatabaseOperations,
  transaction: async (callback: (tx: typeof fakeDatabaseOperations) => Promise<unknown>) =>
    callback(fakeDatabaseOperations),
};

mock.module('../config', () => ({
  config: {
    NANGO_API_KEY: '',
    NANGO_BASE_URL: 'https://api.nango.dev',
    NANGO_WEBHOOK_SIGNING_KEY: '',
    NANGO_GITHUB_ACCOUNT_INTEGRATION_ID: '',
    NANGO_GITHUB_MANAGED_INTEGRATION_ID: '',
  },
}));
mock.module('../shared/db', () => ({ db: fakeDatabase }));
mock.module('../lib/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const {
  createNangoWebhookHandler,
  nangoWebhookApp,
  postgresNangoGithubConnectionStore,
  readNangoWebhookBody,
  verifyNangoWebhookSignature,
} = await import('../webhooks/nango');
const { GitHubInstallationAuthorizationError } = await import('../projects/github');

const signingKey = 'nango-webhook-signing-key';
const accountIntegrationId = 'github-account';
const managedIntegrationId = 'github-managed';
const managedEnvironmentId = 'kortix_test_environment';
const tags = buildAccountNangoTags({
  accountId: '6b70ddb0-a373-4291-85ca-31e306ac4f95',
  userId: '3bfc6305-421b-4bd8-b290-9d0e410e6eca',
  displayName: 'Acme',
  connectAttemptId: '9cf75b4a-790d-4e74-8da8-d6be32b3b598',
});

const installation: GithubInstallationMetadata = {
  installationId: '125146708',
  ownerLogin: 'acme',
  ownerType: 'Organization',
  repositorySelection: 'selected',
  permissions: { contents: 'write', metadata: 'read' },
  installationUrl: 'https://github.com/organizations/acme/settings/installations/125146708',
};

const accountConnection: NangoConnection = {
  id: 1,
  connectionId: 'connection-1',
  integrationId: accountIntegrationId,
  provider: 'github-app-oauth',
  errors: [],
  metadata: {},
  connectionConfig: { installation_id: installation.installationId },
  tags,
  createdAt: '2026-07-27T17:00:00.000Z',
  updatedAt: '2026-07-27T17:01:00.000Z',
  lastFetchedAt: '2026-07-27T17:02:00.000Z',
  credentials: {
    type: 'CUSTOM',
    app: {
      type: 'APP',
      access_token: 'ghs_installation_secret',
      expires_at: '2026-07-27T18:02:00.000Z',
      raw: {
        permissions: installation.permissions,
        repository_selection: installation.repositorySelection,
      },
    },
    user: {
      type: 'OAUTH2',
      access_token: 'ghu_user_secret',
      raw: {},
    },
    raw: {},
  },
};

function toConnectionSummary(connection: NangoConnection): NangoConnectionSummary {
  const { credentials: _credentials, ...summary } = connection;
  return summary;
}

type ReconcileInput = Parameters<NangoGithubConnectionStore['reconcileAccountConnection']>[0];
type RefreshFailureInput = Parameters<NangoGithubConnectionStore['markNeedsReconnect']>[0];

function makeStore() {
  const reconciliations: ReconcileInput[] = [];
  const refreshFailures: RefreshFailureInput[] = [];
  const rows = new Map<string, ReconcileInput>();
  const store: NangoGithubConnectionStore = {
    findAccountConnection: async (connectionId) => {
      const row = rows.get(connectionId);
      return row
        ? {
            accountId: row.accountId,
            installationId: row.installation.installationId,
            connectionId: row.connectionId,
            integrationId: row.integrationId,
            ownerLogin: row.installation.ownerLogin,
            ownerType: row.installation.ownerType,
            status: 'connected',
          }
        : null;
    },
    reconcileAccountConnection: async (input) => {
      reconciliations.push(input);
      rows.set(input.connectionId, input);
      return { changedProjectCount: 2 };
    },
    markNeedsReconnect: async (input) => {
      refreshFailures.push(input);
      return { changedProjectCount: 2 };
    },
  };
  return { store, reconciliations, refreshFailures, rows };
}

function webhookBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'auth',
    operation: 'creation',
    connectionId: 'connection-1',
    authMode: 'CUSTOM',
    providerConfigKey: accountIntegrationId,
    provider: 'github-app-oauth',
    environment: 'DEV',
    success: true,
    tags,
    ...overrides,
  };
}

function signedRequest(
  body: Record<string, unknown>,
  secret = signingKey,
): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    signature: createHmac('sha256', secret).update(rawBody).digest('hex'),
  };
}

function makeHandler(
  input: {
    connection?: NangoConnection;
    summaries?: NangoConnectionSummary[];
    store?: NangoGithubConnectionStore;
    logs?: unknown[];
    getConnectionError?: unknown;
    verifyOwnerError?: unknown;
    inspectedInstallation?: GithubInstallationMetadata;
    accountIntegrationId?: string;
    managedIntegrationId?: string;
    managedEnvironmentId?: string;
    managedStore?: ManagedGithubConnectionStore;
    accountAuthorized?: boolean;
  } = {},
) {
  const fetched: string[] = [];
  const listed: string[] = [];
  const authorizationChecks: Array<{ accountId: string; userId: string }> = [];
  const handler = createNangoWebhookHandler({
    signingKey,
    accountIntegrationId: input.accountIntegrationId ?? accountIntegrationId,
    managedIntegrationId: input.managedIntegrationId ?? managedIntegrationId,
    managedEnvironmentId: input.managedEnvironmentId ?? managedEnvironmentId,
    client: {
      createConnectSession: async () => {
        throw new Error('not used');
      },
      createReconnectSession: async () => {
        throw new Error('not used');
      },
      listConnections: async ({ connectionId } = {}) => {
        listed.push(connectionId ?? '');
        return input.summaries ?? [toConnectionSummary(accountConnection)];
      },
      getConnection: async ({ connectionId }) => {
        fetched.push(connectionId);
        if (input.getConnectionError) throw input.getConnectionError;
        return input.connection ?? accountConnection;
      },
      deleteConnection: async () => undefined,
    },
    store: input.store ?? makeStore().store,
    managedStore: input.managedStore ?? {
      getSelected: async () => null,
      saveSelected: async () => undefined,
      markNeedsReconnect: async () => ({ changedProjectCount: 0 }),
      markManagedProjectsUnavailable: async () => undefined,
    },
    authorizeAccountConnection: async (scope) => {
      authorizationChecks.push(scope);
      return input.accountAuthorized !== false;
    },
    inspectInstallation: async () => input.inspectedInstallation ?? installation,
    verifyInstallationOwner: async ({ userToken, installation: candidate }) => {
      expect(userToken).toBe('ghu_user_secret');
      expect(candidate).toEqual(input.inspectedInstallation ?? installation);
      if (input.verifyOwnerError) throw input.verifyOwnerError;
      return { githubLogin: 'octocat' };
    },
    logger: {
      info: (message, fields) => input.logs?.push({ level: 'info', message, fields }),
      warn: (message, fields) => input.logs?.push({ level: 'warn', message, fields }),
      error: (message, fields) => input.logs?.push({ level: 'error', message, fields }),
    },
  });
  return { handler, fetched, listed, authorizationChecks };
}

describe('Nango webhook signature verification', () => {
  test('mounts at the exact public webhook path without bearer authentication', async () => {
    const { Hono } = await import('hono');
    const app = new Hono();
    app.route('/v1/webhooks/nango', nangoWebhookApp);

    const response = await app.request('/v1/webhooks/nango', {
      method: 'POST',
      body: '{}',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'nango_not_configured',
    });
  });

  test('accepts exact raw-body HMAC and rejects malformed or changed signatures', () => {
    const rawBody = '{"type":"auth","success":true}';
    const signature = createHmac('sha256', signingKey).update(rawBody).digest('hex');

    expect(verifyNangoWebhookSignature(rawBody, signature, signingKey)).toBe(true);
    expect(verifyNangoWebhookSignature(`${rawBody} `, signature, signingKey)).toBe(false);
    expect(verifyNangoWebhookSignature(rawBody, 'not-hex', signingKey)).toBe(false);
    expect(verifyNangoWebhookSignature(rawBody, undefined, signingKey)).toBe(false);
  });

  test('bounds the raw request body before JSON parsing', async () => {
    await expect(
      readNangoWebhookBody(
        new Request('https://api.example.test/v1/webhooks/nango', {
          method: 'POST',
          body: 'x'.repeat(9),
        }),
        8,
      ),
    ).rejects.toThrow();
  });
});

describe('Nango auth webhook reconciliation', () => {
  test('upserts one account installation and matching projects idempotently', async () => {
    const state = makeStore();
    const { handler, fetched } = makeHandler({ store: state.store });
    const request = signedRequest(webhookBody());

    const first = await handler(request);
    const second = await handler(request);

    expect(first).toEqual({
      status: 200,
      body: {
        ok: true,
        operation: 'creation',
        connection_id: 'connection-1',
        changed_project_count: 2,
      },
    });
    expect(second).toEqual(first);
    expect(fetched).toEqual(['connection-1', 'connection-1']);
    expect(state.reconciliations).toHaveLength(2);
    expect(state.rows).toHaveLength(1);
    expect(state.reconciliations[0]).toEqual({
      accountId: tags.kortix_account_id,
      initiatingUserId: tags.kortix_user_id,
      connectAttemptId: tags.kortix_connect_attempt_id,
      connectionId: 'connection-1',
      integrationId: accountIntegrationId,
      installation,
    });
    expect(JSON.stringify(state.reconciliations)).not.toContain('ghu_user_secret');
    expect(JSON.stringify(state.reconciliations)).not.toContain('ghs_installation_secret');
  });

  test('accepts an override for the same connection ID', async () => {
    const state = makeStore();
    const { handler } = makeHandler({ store: state.store });
    const request = signedRequest(webhookBody({ operation: 'override' }));

    const result = await handler(request);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operation: 'override',
      connection_id: 'connection-1',
    });
    expect(state.reconciliations).toHaveLength(1);
  });

  test('marks the stored connection needs_reconnect when override changes installation identity', async () => {
    const state = makeStore();
    await state.store.reconcileAccountConnection({
      accountId: tags.kortix_account_id,
      initiatingUserId: tags.kortix_user_id,
      connectAttemptId: tags.kortix_connect_attempt_id,
      connectionId: 'connection-1',
      integrationId: accountIntegrationId,
      installation,
    });
    state.reconciliations.length = 0;

    const changedInstallation: GithubInstallationMetadata = {
      ...installation,
      installationId: '999',
      ownerLogin: 'other-owner',
      installationUrl: 'https://github.com/settings/installations/999',
    };
    const { handler } = makeHandler({
      store: state.store,
      connection: {
        ...accountConnection,
        connectionConfig: { installation_id: changedInstallation.installationId },
      },
      inspectedInstallation: changedInstallation,
    });

    const result = await handler(signedRequest(webhookBody({ operation: 'override' })));

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        ignored: true,
        reason: 'connection_identity_changed',
        changed_project_count: 2,
      },
    });
    expect(state.reconciliations).toEqual([]);
    expect(state.refreshFailures).toEqual([
      {
        accountId: tags.kortix_account_id,
        connectionId: 'connection-1',
        integrationId: accountIntegrationId,
        errorCode: 'nango_connection_identity_changed',
      },
    ]);
  });

  test('rejects invalid HMAC before Nango or database access', async () => {
    const state = makeStore();
    const { handler, fetched, listed } = makeHandler({ store: state.store });

    const result = await handler({
      rawBody: JSON.stringify(webhookBody()),
      signature: '0'.repeat(64),
    });

    expect(result).toEqual({
      status: 401,
      body: { ok: false, error: 'invalid_webhook_signature' },
    });
    expect(fetched).toEqual([]);
    expect(listed).toEqual([]);
    expect(state.reconciliations).toEqual([]);
    expect(state.refreshFailures).toEqual([]);
  });

  test('ignores mismatched tags, integration, provider, and unknown connections without mutation', async () => {
    const cases: Array<{
      body: Record<string, unknown>;
      connection?: NangoConnection;
    }> = [
      {
        body: webhookBody({
          tags: { ...tags, kortix_account_id: 'not-a-uuid' },
        }),
      },
      {
        body: webhookBody(),
        connection: {
          ...accountConnection,
          tags: {
            ...tags,
            kortix_account_id: '0dd62b5e-94c4-45a9-9d31-5b253e3d7d65',
          },
        },
      },
      {
        body: webhookBody({ providerConfigKey: 'other-integration' }),
      },
      {
        body: webhookBody({ provider: 'github' }),
      },
      {
        body: webhookBody(),
        connection: { ...accountConnection, connectionId: 'different-connection' },
      },
    ];

    for (const candidate of cases) {
      const state = makeStore();
      const { handler } = makeHandler({
        store: state.store,
        connection: candidate.connection,
      });
      const result = await handler(signedRequest(candidate.body));

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true, ignored: true });
      expect(state.reconciliations).toEqual([]);
      expect(state.refreshFailures).toEqual([]);
    }
  });

  test('ignores a completed Connect session after the initiating user loses account access', async () => {
    const state = makeStore();
    const { handler, fetched, authorizationChecks } = makeHandler({
      store: state.store,
      accountAuthorized: false,
    });

    const result = await handler(signedRequest(webhookBody()));

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        ignored: true,
        reason: 'account_authorization_expired',
      },
    });
    expect(authorizationChecks).toEqual([
      {
        accountId: tags.kortix_account_id,
        userId: tags.kortix_user_id,
      },
    ]);
    expect(fetched).toEqual([]);
    expect(state.reconciliations).toEqual([]);
    expect(state.refreshFailures).toEqual([]);
  });

  test('marks a connection and matching projects needs_reconnect on refresh failure', async () => {
    const state = makeStore();
    await state.store.reconcileAccountConnection({
      accountId: tags.kortix_account_id,
      initiatingUserId: tags.kortix_user_id,
      connectAttemptId: tags.kortix_connect_attempt_id,
      connectionId: 'connection-1',
      integrationId: accountIntegrationId,
      installation,
    });
    state.reconciliations.length = 0;
    const { handler, listed } = makeHandler({
      store: state.store,
      summaries: [
        {
          ...toConnectionSummary(accountConnection),
          integrationId: managedIntegrationId,
          provider: 'github-app',
        },
        toConnectionSummary(accountConnection),
      ],
    });
    const request = signedRequest(
      webhookBody({
        operation: 'refresh',
        success: false,
        error: {
          type: 'invalid_grant',
          description: 'raw-provider-description-with-ghu_secret',
        },
      }),
    );

    const result = await handler(request);

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        operation: 'refresh',
        connection_id: 'connection-1',
        changed_project_count: 2,
      },
    });
    expect(listed).toEqual(['connection-1']);
    expect(state.refreshFailures).toEqual([
      {
        accountId: tags.kortix_account_id,
        connectionId: 'connection-1',
        integrationId: accountIntegrationId,
        errorCode: 'nango_refresh_failed',
      },
    ]);
    expect(JSON.stringify(state.refreshFailures)).not.toContain('raw-provider-description');
  });

  test('acknowledges an installation owner authorization rejection without retrying', async () => {
    const state = makeStore();
    const { handler } = makeHandler({
      store: state.store,
      verifyOwnerError: new GitHubInstallationAuthorizationError(),
    });

    const result = await handler(signedRequest(webhookBody()));

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        ignored: true,
        reason: 'installation_owner_not_authorized',
      },
    });
    expect(state.reconciliations).toEqual([]);
  });

  test('marks an existing connection needs_reconnect when owner authorization is rejected', async () => {
    const state = makeStore();
    await state.store.reconcileAccountConnection({
      accountId: tags.kortix_account_id,
      initiatingUserId: tags.kortix_user_id,
      connectAttemptId: tags.kortix_connect_attempt_id,
      connectionId: 'connection-1',
      integrationId: accountIntegrationId,
      installation,
    });
    state.reconciliations.length = 0;
    const { handler } = makeHandler({
      store: state.store,
      verifyOwnerError: new GitHubInstallationAuthorizationError(),
    });

    const result = await handler(signedRequest(webhookBody({ operation: 'override' })));

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        ignored: true,
        reason: 'installation_owner_not_authorized',
        changed_project_count: 2,
      },
    });
    expect(state.reconciliations).toEqual([]);
    expect(state.refreshFailures).toEqual([
      {
        accountId: tags.kortix_account_id,
        connectionId: 'connection-1',
        integrationId: accountIntegrationId,
        errorCode: 'nango_installation_owner_not_authorized',
      },
    ]);
  });

  test('returns 503 for account webhooks when only managed Nango is configured', async () => {
    const state = makeStore();
    const { handler } = makeHandler({
      store: state.store,
      accountIntegrationId: '',
    });

    const result = await handler(signedRequest(webhookBody()));

    expect(result).toEqual({
      status: 503,
      body: { ok: false, error: 'nango_account_integration_not_configured' },
    });
    expect(state.reconciliations).toEqual([]);
  });

  test('returns 503 for managed webhooks when only account Nango is configured', async () => {
    const state = makeStore();
    const { handler } = makeHandler({
      store: state.store,
      managedIntegrationId: '',
    });

    const result = await handler(
      signedRequest({
        type: 'auth',
        operation: 'creation',
        connectionId: 'managed-connection',
        authMode: 'APP',
        providerConfigKey: managedIntegrationId,
        provider: 'github-app',
        success: true,
        tags: buildManagedNangoTags({
          selectedByUserId: tags.kortix_user_id,
          displayName: 'Kortix Managed GitHub',
          connectAttemptId: '436b7337-728f-487f-a7e8-306a8fa5ea30',
        }),
      }),
    );

    expect(result).toEqual({
      status: 503,
      body: { ok: false, error: 'nango_managed_integration_not_configured' },
    });
    expect(state.reconciliations).toEqual([]);
  });

  test('preserves Retry-After when Nango rate-limits reconciliation', async () => {
    const state = makeStore();
    const { handler } = makeHandler({
      store: state.store,
      getConnectionError: new NangoError('github_provider_rate_limited', 429, {
        retryAfter: '23',
        upstreamStatus: 429,
      }),
    });

    const result = await handler(signedRequest(webhookBody()));

    expect(result).toEqual({
      status: 429,
      headers: { 'retry-after': '23' },
      body: { ok: false, error: 'github_provider_rate_limited' },
    });
    expect(state.reconciliations).toEqual([]);
  });

  test('acknowledges unknown webhook types without Nango or database access', async () => {
    const state = makeStore();
    const { handler, fetched, listed } = makeHandler({ store: state.store });
    const request = signedRequest({ type: 'sync', operation: 'started' });

    const result = await handler(request);

    expect(result).toEqual({
      status: 200,
      body: { ok: true, ignored: true, reason: 'unsupported_event' },
    });
    expect(fetched).toEqual([]);
    expect(listed).toEqual([]);
    expect(state.reconciliations).toEqual([]);
  });

  test('acknowledges managed connections until an admin selects one', async () => {
    const state = makeStore();
    const { handler, fetched, listed } = makeHandler({ store: state.store });
    const request = signedRequest({
      type: 'auth',
      operation: 'creation',
      connectionId: 'managed-connection',
      authMode: 'APP',
      providerConfigKey: managedIntegrationId,
      provider: 'github-app',
      success: true,
      tags: {
        ...buildManagedNangoTags({
          selectedByUserId: tags.kortix_user_id,
          displayName: 'Kortix Managed GitHub',
          connectAttemptId: '436b7337-728f-487f-a7e8-306a8fa5ea30',
        }),
        kortix_environment_id: managedEnvironmentId,
      },
    });

    const result = await handler(request);

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        ignored: true,
        reason: 'managed_connection_selection_required',
      },
    });
    expect(fetched).toEqual([]);
    expect(listed).toEqual([]);
    expect(state.reconciliations).toEqual([]);
  });

  test('marks a selected managed connection and its projects needs_reconnect on refresh failure', async () => {
    const managedTags = {
      ...buildManagedNangoTags({
        selectedByUserId: tags.kortix_user_id,
        displayName: 'Kortix Managed GitHub',
        connectAttemptId: '436b7337-728f-487f-a7e8-306a8fa5ea30',
      }),
      kortix_environment_id: managedEnvironmentId,
    };
    const reconnects: Parameters<ManagedGithubConnectionStore['markNeedsReconnect']>[0][] = [];
    const managedStore: ManagedGithubConnectionStore = {
      getSelected: async () => ({
        schemaVersion: 1,
        connectionId: 'managed-connection',
        integrationId: managedIntegrationId,
        installationId: installation.installationId,
        owner: { login: 'acme', type: 'Organization' },
        status: 'connected',
        selectedByUserId: tags.kortix_user_id,
        selectedAt: '2026-07-27T17:00:00.000Z',
      }),
      saveSelected: async () => undefined,
      markNeedsReconnect: async (input) => {
        reconnects.push(input);
        return { changedProjectCount: 3 };
      },
      markManagedProjectsUnavailable: async () => undefined,
    };
    const { handler, listed } = makeHandler({
      managedStore,
      summaries: [
        {
          connectionId: 'managed-connection',
          integrationId: managedIntegrationId,
          provider: 'github-app',
          errors: [],
          metadata: {},
          connectionConfig: { installation_id: installation.installationId },
          tags: managedTags,
        },
      ],
    });

    const result = await handler(
      signedRequest({
        type: 'auth',
        operation: 'refresh',
        connectionId: 'managed-connection',
        authMode: 'APP',
        providerConfigKey: managedIntegrationId,
        provider: 'github-app',
        success: false,
        tags: managedTags,
      }),
    );

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        operation: 'refresh',
        connection_id: 'managed-connection',
        changed_project_count: 3,
      },
    });
    expect(listed).toEqual(['managed-connection']);
    expect(reconnects).toEqual([
      {
        connectionId: 'managed-connection',
        integrationId: managedIntegrationId,
        installationId: installation.installationId,
      },
    ]);
  });

  test('does not write API keys, GitHub tokens, or raw credential payloads to logs', async () => {
    const logs: unknown[] = [];
    const state = makeStore();
    const { handler } = makeHandler({ store: state.store, logs });

    await handler(signedRequest(webhookBody()));

    const snapshot = JSON.stringify(logs);
    expect(snapshot).not.toContain(signingKey);
    expect(snapshot).not.toContain('ghu_user_secret');
    expect(snapshot).not.toContain('ghs_installation_secret');
    expect(snapshot).not.toContain('credentials');
    expect(snapshot).toContain('connection-1');
  });
});

describe('Postgres Nango GitHub connection store', () => {
  test('persists credential-free installation metadata and updates matching projects', async () => {
    databaseSelectResults = [[], []];
    databaseReturningResults = [[{ connectionId: 'project-git-1' }]];
    databaseInserts.length = 0;
    databaseUpdates.length = 0;

    const result = await postgresNangoGithubConnectionStore.reconcileAccountConnection({
      accountId: tags.kortix_account_id,
      initiatingUserId: tags.kortix_user_id,
      connectAttemptId: tags.kortix_connect_attempt_id,
      connectionId: 'connection-1',
      integrationId: accountIntegrationId,
      installation,
    });

    expect(result).toEqual({ changedProjectCount: 1 });
    expect(databaseInserts).toHaveLength(1);
    expect(databaseInserts[0]?.table).toBe(accountGithubInstallations);
    expect(databaseInserts[0]?.values).toMatchObject({
      accountId: tags.kortix_account_id,
      installationId: installation.installationId,
      nangoConnectionId: 'connection-1',
      nangoIntegrationId: accountIntegrationId,
      connectionStatus: 'connected',
      ownerLogin: 'acme',
      ownerType: 'Organization',
      permissions: installation.permissions,
      metadata: {
        html_url: installation.installationUrl,
        connection_provider: 'nango',
        connect_attempt_id: tags.kortix_connect_attempt_id,
        linked_by_user_id: tags.kortix_user_id,
      },
    });
    const persistedSnapshot = JSON.stringify(databaseInserts.map((record) => record.values));
    expect(persistedSnapshot).not.toContain('ghu_');
    expect(persistedSnapshot).not.toContain('ghs_');
    expect(persistedSnapshot).not.toContain('jwt');

    expect(databaseUpdates).toHaveLength(1);
    expect(databaseUpdates[0]?.table).toBe(projectGitConnections);
    expect(databaseUpdates[0]?.values).toMatchObject({
      authMethod: 'nango',
      credentialRef: 'connection-1',
      status: 'connected',
      lastErrorCode: null,
      lastErrorMessage: null,
    });
  });

  test('marks both installation and project state as needs_reconnect', async () => {
    databaseSelectResults = [
      [
        {
          accountId: tags.kortix_account_id,
          integrationId: accountIntegrationId,
        },
      ],
    ];
    databaseReturningResults = [[{ connectionId: 'project-git-1' }]];
    databaseUpdates.length = 0;

    const result = await postgresNangoGithubConnectionStore.markNeedsReconnect({
      accountId: tags.kortix_account_id,
      connectionId: 'connection-1',
      integrationId: accountIntegrationId,
      errorCode: 'nango_refresh_failed',
    });

    expect(result).toEqual({ changedProjectCount: 1 });
    expect(databaseUpdates).toHaveLength(2);
    expect(databaseUpdates[0]).toMatchObject({
      table: accountGithubInstallations,
      values: {
        connectionStatus: 'needs_reconnect',
        lastErrorCode: 'nango_refresh_failed',
        lastErrorMessage: 'GitHub authorization must be reconnected.',
      },
    });
    expect(databaseUpdates[1]).toMatchObject({
      table: projectGitConnections,
      values: {
        status: 'needs_reconnect',
        lastErrorCode: 'nango_refresh_failed',
        lastErrorMessage: 'GitHub authorization must be reconnected.',
      },
    });
  });
});

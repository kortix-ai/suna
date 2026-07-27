import { randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGithubInstallations, projectGitConnections } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { config } from '../../config';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { auth, json, makeOpenApiApp } from '../../openapi';
import { db } from '../../shared/db';
import { resolveProjectAccount } from '../lib/access';
import { serializeGitHubInstallation } from '../lib/serializers';
import { type NangoClient, createNangoClient } from '../nango/client';
import { isNangoError } from '../nango/errors';
import {
  buildAccountNangoTags,
  decodeAccountGithubConnection,
  nangoWebhookUrlOverride,
} from '../nango/github-connection';

export type StoredGithubNangoConnection = typeof accountGithubInstallations.$inferSelect;

export interface GithubNangoConnectionStore {
  list(accountId: string): Promise<StoredGithubNangoConnection[]>;
  get(accountId: string, installationId: string): Promise<StoredGithubNangoConnection | null>;
  markConnected(connection: StoredGithubNangoConnection): Promise<StoredGithubNangoConnection>;
  markNeedsReconnect(connection: StoredGithubNangoConnection): Promise<StoredGithubNangoConnection>;
  disconnect(connection: StoredGithubNangoConnection): Promise<StoredGithubNangoConnection>;
}

interface GithubNangoRouteDependencies {
  client: NangoClient;
  store: GithubNangoConnectionStore;
  accountIntegrationId: string;
  webhookUrlOverride?: string;
  createAttemptId(): string;
  resolveAccount(
    context: Context,
    body?: Record<string, unknown>,
  ): Promise<{ userId: string; accountId: string }>;
  authorize(input: {
    userId: string;
    accountId: string;
    action: string;
  }): Promise<void>;
}

const sessionResponseSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  connect_link: z.string(),
});

const installationResponseSchema = z
  .object({
    account_id: z.string(),
    installation_id: z.string().nullable(),
    connection_id: z.string().nullable(),
    connection_provider: z.string().nullable(),
    connection_status: z.string().nullable(),
    reconnect_required: z.boolean(),
  })
  .passthrough();

const disconnectResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

const errorResponseSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
    account_id: z.string().optional(),
    installation_id: z.string().optional(),
    requires_human_oauth: z.boolean().optional(),
    sdk_action: z.string().optional(),
  })
  .passthrough();

const connectionErrorResponse = json(errorResponseSchema, 'GitHub connection error');

function connectionGuidance(
  code: 'github_connection_required' | 'github_reconnect_required',
  accountId: string,
  installationId: string,
) {
  return {
    error:
      code === 'github_connection_required'
        ? 'A GitHub connection is required.'
        : 'The GitHub connection must be reconnected.',
    code,
    account_id: accountId,
    installation_id: installationId,
    requires_human_oauth: true,
    sdk_action:
      code === 'github_connection_required'
        ? 'createGitHubConnectSession'
        : 'createGitHubReconnectSession',
  };
}

function serializeSession(session: Awaited<ReturnType<NangoClient['createConnectSession']>>) {
  return {
    token: session.token,
    expires_at: session.expiresAt,
    connect_link: session.connectLink,
  };
}

function accountTags(
  dependencies: GithubNangoRouteDependencies,
  scope: { userId: string; accountId: string },
) {
  return buildAccountNangoTags({
    accountId: scope.accountId,
    userId: scope.userId,
    displayName: scope.accountId,
    connectAttemptId: dependencies.createAttemptId(),
  });
}

function connectionRef(connection: StoredGithubNangoConnection) {
  if (!connection.nangoConnectionId || !connection.nangoIntegrationId) {
    return null;
  }
  return {
    connectionId: connection.nangoConnectionId,
    integrationId: connection.nangoIntegrationId,
  };
}

async function readBody(context: Context): Promise<Record<string, unknown>> {
  try {
    const value = await context.req.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function productionNangoClient(): NangoClient {
  return createNangoClient({
    apiKey: config.NANGO_API_KEY,
    baseUrl: config.NANGO_BASE_URL,
  });
}

let cachedProductionClient: NangoClient | null = null;

function lazyProductionClient(): NangoClient {
  const getClient = () => {
    cachedProductionClient ??= productionNangoClient();
    return cachedProductionClient;
  };
  return {
    createConnectSession: (input) => getClient().createConnectSession(input),
    createReconnectSession: (input) => getClient().createReconnectSession(input),
    listConnections: (input) => getClient().listConnections(input),
    getConnection: (input) => getClient().getConnection(input),
    deleteConnection: (input) => getClient().deleteConnection(input),
  };
}

async function updateProjectConnectionState(
  transaction: Pick<typeof db, 'update'>,
  connection: StoredGithubNangoConnection,
  values: {
    status: 'connected' | 'needs_reconnect' | 'disconnected';
    lastValidatedAt: Date;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  },
) {
  await transaction
    .update(projectGitConnections)
    .set({
      status: values.status,
      lastValidatedAt: values.lastValidatedAt,
      lastErrorCode: values.lastErrorCode,
      lastErrorMessage: values.lastErrorMessage,
      updatedAt: values.lastValidatedAt,
      ...(values.status === 'connected' && connection.nangoConnectionId
        ? {
            authMethod: 'nango',
            credentialRef: connection.nangoConnectionId,
          }
        : {}),
    })
    .where(
      and(
        eq(projectGitConnections.accountId, connection.accountId),
        eq(projectGitConnections.installationId, connection.installationId),
        eq(projectGitConnections.provider, 'github'),
      ),
    );
}

async function updateStoredConnection(
  database: typeof db,
  connection: StoredGithubNangoConnection,
  values: {
    connectionStatus: 'connected' | 'needs_reconnect' | 'disconnected';
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    disconnectedAt: Date | null;
  },
): Promise<StoredGithubNangoConnection> {
  return database.transaction(async (transaction) => {
    const now = new Date();
    const [updated] = await transaction
      .update(accountGithubInstallations)
      .set({
        ...values,
        lastValidatedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(accountGithubInstallations.accountId, connection.accountId),
          eq(accountGithubInstallations.installationId, connection.installationId),
        ),
      )
      .returning();
    if (!updated) throw new Error('GitHub connection state update failed.');
    await updateProjectConnectionState(transaction, connection, {
      status: values.connectionStatus,
      lastValidatedAt: now,
      lastErrorCode: values.lastErrorCode,
      lastErrorMessage: values.lastErrorMessage,
    });
    return updated;
  });
}

export function createGithubNangoConnectionStore(database: typeof db): GithubNangoConnectionStore {
  return {
    list: async (accountId) =>
      database
        .select()
        .from(accountGithubInstallations)
        .where(eq(accountGithubInstallations.accountId, accountId)),
    get: async (accountId, installationId) => {
      const [row] = await database
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
    markConnected: (connection) =>
      updateStoredConnection(database, connection, {
        connectionStatus: 'connected',
        lastErrorCode: null,
        lastErrorMessage: null,
        disconnectedAt: null,
      }),
    markNeedsReconnect: (connection) =>
      updateStoredConnection(database, connection, {
        connectionStatus: 'needs_reconnect',
        lastErrorCode: 'github_reconnect_required',
        lastErrorMessage: 'The GitHub connection must be reconnected.',
        disconnectedAt: null,
      }),
    disconnect: (connection) =>
      updateStoredConnection(database, connection, {
        connectionStatus: 'disconnected',
        lastErrorCode: null,
        lastErrorMessage: null,
        disconnectedAt: new Date(),
      }),
  };
}

export const postgresGithubNangoConnectionStore = createGithubNangoConnectionStore(db);

function productionDependencies(): GithubNangoRouteDependencies {
  return {
    client: lazyProductionClient(),
    store: postgresGithubNangoConnectionStore,
    accountIntegrationId: config.NANGO_GITHUB_ACCOUNT_INTEGRATION_ID,
    webhookUrlOverride: nangoWebhookUrlOverride(
      config.KORTIX_URL,
      config.INTERNAL_KORTIX_ENV === 'dev',
    ),
    createAttemptId: randomUUID,
    resolveAccount: resolveProjectAccount,
    authorize: async ({ userId, accountId, action }) => {
      await assertAuthorized(userId, accountId, action);
    },
  };
}

function responseForNangoError(context: Context, error: unknown) {
  if (!isNangoError(error)) {
    return context.json({ error: 'GitHub connection operation failed.' }, 500);
  }
  if (error.retryAfter) context.header('Retry-After', error.retryAfter);
  const body = { error: error.message, code: error.code };
  switch (error.status) {
    case 409:
      return context.json(body, 409);
    case 429:
      return context.json(body, 429);
    case 502:
      return context.json(body, 502);
    case 503:
      return context.json(body, 503);
    default:
      return context.json({ error: 'GitHub connection operation failed.' }, 500);
  }
}

export function createGithubNangoConnectionsApp(
  overrides: Partial<GithubNangoRouteDependencies> = {},
) {
  const dependencies = { ...productionDependencies(), ...overrides };
  const app = makeOpenApiApp();

  app.openapi(
    createRoute({
      method: 'post',
      path: '/connect-session',
      tags: ['github'],
      summary: 'Create an account GitHub Connect session',
      ...auth,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({ account_id: z.string().optional() }).passthrough(),
            },
          },
        },
      },
      responses: {
        200: json(sessionResponseSchema, 'Nango Connect session'),
        400: connectionErrorResponse,
        403: connectionErrorResponse,
        409: connectionErrorResponse,
        429: connectionErrorResponse,
        500: connectionErrorResponse,
        502: connectionErrorResponse,
        503: connectionErrorResponse,
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: zod-openapi cannot infer custom multi-status error envelopes.
    async (context: any): Promise<any> => {
      const body = await readBody(context);
      const scope = await dependencies.resolveAccount(context, body);
      await dependencies.authorize({
        ...scope,
        action: ACCOUNT_ACTIONS.PROJECT_CREATE,
      });
      if (!dependencies.accountIntegrationId) {
        return context.json({ error: 'Nango account GitHub integration is not configured.' }, 503);
      }
      try {
        const session = await dependencies.client.createConnectSession({
          integrationId: dependencies.accountIntegrationId,
          tags: accountTags(dependencies, scope),
          ...(dependencies.webhookUrlOverride
            ? { webhookUrlOverride: dependencies.webhookUrlOverride }
            : {}),
        });
        return context.json(serializeSession(session), 200);
      } catch (error) {
        return responseForNangoError(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/installations/{installationId}/reconnect-session',
      tags: ['github'],
      summary: 'Create a GitHub reconnect session',
      ...auth,
      request: {
        params: z.object({ installationId: z.string().min(1) }),
        body: {
          content: {
            'application/json': {
              schema: z.object({ account_id: z.string().optional() }).passthrough(),
            },
          },
        },
      },
      responses: {
        200: json(sessionResponseSchema, 'Nango reconnect session'),
        409: json(errorResponseSchema, 'Connection required'),
        400: connectionErrorResponse,
        403: connectionErrorResponse,
        404: connectionErrorResponse,
        429: connectionErrorResponse,
        500: connectionErrorResponse,
        502: connectionErrorResponse,
        503: connectionErrorResponse,
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: zod-openapi cannot infer custom multi-status error envelopes.
    async (context: any) => {
      const body = await readBody(context);
      const scope = await dependencies.resolveAccount(context, body);
      await dependencies.authorize({
        ...scope,
        action: ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      });
      const installationId = context.req.valid('param').installationId;
      const connection = await dependencies.store.get(scope.accountId, installationId);
      if (!connection) {
        return context.json({ error: 'GitHub installation not found.' }, 404);
      }
      const ref = connectionRef(connection);
      if (!ref) {
        return context.json(
          connectionGuidance('github_connection_required', scope.accountId, installationId),
          409,
        );
      }
      try {
        const session = await dependencies.client.createReconnectSession({
          ...ref,
          tags: accountTags(dependencies, scope),
          ...(dependencies.webhookUrlOverride
            ? { webhookUrlOverride: dependencies.webhookUrlOverride }
            : {}),
        });
        return context.json(serializeSession(session), 200);
      } catch (error) {
        return responseForNangoError(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/installations/{installationId}/refresh',
      tags: ['github'],
      summary: 'Refresh GitHub connection status',
      ...auth,
      request: {
        params: z.object({ installationId: z.string().min(1) }),
        body: {
          content: {
            'application/json': {
              schema: z.object({ account_id: z.string().optional() }).passthrough(),
            },
          },
        },
      },
      responses: {
        200: json(installationResponseSchema, 'GitHub installation status'),
        409: json(errorResponseSchema, 'Connection or reconnect required'),
        400: connectionErrorResponse,
        403: connectionErrorResponse,
        404: connectionErrorResponse,
        429: connectionErrorResponse,
        500: connectionErrorResponse,
        502: connectionErrorResponse,
        503: connectionErrorResponse,
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: zod-openapi cannot infer custom multi-status error envelopes.
    async (context: any) => {
      const body = await readBody(context);
      const scope = await dependencies.resolveAccount(context, body);
      await dependencies.authorize({
        ...scope,
        action: ACCOUNT_ACTIONS.PROJECT_CREATE,
      });
      const installationId = context.req.valid('param').installationId;
      const connection = await dependencies.store.get(scope.accountId, installationId);
      if (!connection) {
        return context.json({ error: 'GitHub installation not found.' }, 404);
      }
      const ref = connectionRef(connection);
      if (!ref) {
        return context.json(
          connectionGuidance('github_connection_required', scope.accountId, installationId),
          409,
        );
      }
      if (connection.connectionStatus !== 'connected') {
        return context.json(
          connectionGuidance('github_reconnect_required', scope.accountId, installationId),
          409,
        );
      }
      try {
        const current = await dependencies.client.getConnection({
          ...ref,
          forceRefresh: true,
        });
        const credential = decodeAccountGithubConnection(current, {
          integrationId: ref.integrationId,
        });
        if (credential.installationId !== installationId) {
          await dependencies.store.markNeedsReconnect(connection);
          return context.json(
            connectionGuidance('github_reconnect_required', scope.accountId, installationId),
            409,
          );
        }
        const updated = await dependencies.store.markConnected(connection);
        return context.json(serializeGitHubInstallation(updated, scope.accountId, null), 200);
      } catch (error) {
        if (isNangoError(error) && error.code === 'github_reconnect_required') {
          await dependencies.store.markNeedsReconnect(connection);
          return context.json(
            connectionGuidance('github_reconnect_required', scope.accountId, installationId),
            409,
          );
        }
        return responseForNangoError(context, error);
      }
    },
  );

  async function disconnectOne(
    context: Context,
    scope: { userId: string; accountId: string },
    installationId: string,
  ) {
    const connection = await dependencies.store.get(scope.accountId, installationId);
    if (!connection) {
      return context.json({ ok: true }, 200);
    }
    if (connection.connectionStatus === 'disconnected') {
      return context.json(
        {
          ok: true,
          ...serializeGitHubInstallation(connection, scope.accountId, null),
        },
        200,
      );
    }
    const ref = connectionRef(connection);
    try {
      if (ref) await dependencies.client.deleteConnection(ref);
      const updated = await dependencies.store.disconnect(connection);
      return context.json(
        {
          ok: true,
          ...serializeGitHubInstallation(updated, scope.accountId, null),
        },
        200,
      );
    } catch (error) {
      return responseForNangoError(context, error);
    }
  }

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/installations/{installationId}',
      tags: ['github'],
      summary: 'Disconnect a GitHub installation',
      ...auth,
      request: {
        params: z.object({ installationId: z.string().min(1) }),
        query: z.object({ account_id: z.string().optional() }).passthrough(),
      },
      responses: {
        200: json(disconnectResponseSchema, 'Disconnected GitHub installation'),
        403: connectionErrorResponse,
        404: connectionErrorResponse,
        409: connectionErrorResponse,
        429: connectionErrorResponse,
        500: connectionErrorResponse,
        502: connectionErrorResponse,
        503: connectionErrorResponse,
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: zod-openapi cannot infer custom multi-status error envelopes.
    async (context: any): Promise<any> => {
      const scope = await dependencies.resolveAccount(context);
      await dependencies.authorize({
        ...scope,
        action: ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      });
      return disconnectOne(context, scope, context.req.valid('param').installationId);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/installation',
      tags: ['github'],
      summary: 'Disconnect GitHub installations (legacy route)',
      ...auth,
      request: {
        query: z
          .object({
            account_id: z.string().optional(),
            installation_id: z.string().optional(),
            installationId: z.string().optional(),
          })
          .passthrough(),
      },
      responses: {
        200: json(z.object({ ok: z.literal(true) }).passthrough(), 'Disconnected'),
        403: connectionErrorResponse,
        404: connectionErrorResponse,
        409: connectionErrorResponse,
        429: connectionErrorResponse,
        500: connectionErrorResponse,
        502: connectionErrorResponse,
        503: connectionErrorResponse,
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: zod-openapi cannot infer custom multi-status error envelopes.
    async (context: any) => {
      const scope = await dependencies.resolveAccount(context);
      await dependencies.authorize({
        ...scope,
        action: ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      });
      const requested = context.req.query('installation_id') ?? context.req.query('installationId');
      if (requested) {
        const response = await disconnectOne(context, scope, requested);
        if (!response.ok) return response;
        return context.json({ ok: true }, 200);
      }
      const connections = await dependencies.store.list(scope.accountId);
      for (const connection of connections) {
        const response = await disconnectOne(context, scope, connection.installationId);
        if (!response.ok) return response;
      }
      return context.json({ ok: true }, 200);
    },
  );

  return app;
}

export const githubNangoConnectionsApp = createGithubNangoConnectionsApp();

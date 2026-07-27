import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGithubInstallations, projectGitConnections } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../config';
import { ACCOUNT_ACTIONS, authorize } from '../iam';
import { logger as appLogger } from '../lib/logger';
import { errors, json, makeOpenApiApp } from '../openapi';
import {
  type GitHubAppInstallation,
  GitHubInstallationAuthorizationError,
  getGitHubAppInstallationForUserToken,
  verifyGitHubInstallationAdmin,
} from '../projects/github';
import {
  type NangoClient,
  type NangoConnectionSummary,
  createNangoClient,
} from '../projects/nango/client';
import { isNangoError } from '../projects/nango/errors';
import {
  type GithubInstallationMetadata,
  decodeAccountGithubConnection,
  parseAccountNangoTags,
  parseManagedNangoTags,
} from '../projects/nango/github-connection';
import { db } from '../shared/db';

export const NANGO_WEBHOOK_MAX_BODY_BYTES = 262_144;

interface StoredAccountConnection {
  accountId: string;
  installationId: string;
  connectionId: string;
  integrationId: string;
  ownerLogin: string;
  ownerType: string;
  status: string | null;
}

interface ReconcileAccountConnectionInput {
  accountId: string;
  initiatingUserId: string;
  connectAttemptId: string;
  connectionId: string;
  integrationId: string;
  installation: GithubInstallationMetadata;
}

interface MarkNeedsReconnectInput {
  accountId: string;
  connectionId: string;
  integrationId: string;
  errorCode:
    | 'nango_refresh_failed'
    | 'nango_connection_identity_changed'
    | 'nango_installation_owner_not_authorized';
}

export interface NangoGithubConnectionStore {
  findAccountConnection(connectionId: string): Promise<StoredAccountConnection | null>;
  reconcileAccountConnection(
    input: ReconcileAccountConnectionInput,
  ): Promise<{ changedProjectCount: number }>;
  markNeedsReconnect(input: MarkNeedsReconnectInput): Promise<{ changedProjectCount: number }>;
}

interface WebhookLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

interface NangoWebhookHandlerDependencies {
  signingKey: string;
  accountIntegrationId: string;
  managedIntegrationId: string;
  client: NangoClient;
  store: NangoGithubConnectionStore;
  authorizeAccountConnection(input: {
    accountId: string;
    userId: string;
  }): Promise<boolean>;
  inspectInstallation(input: {
    userToken: string;
    installationId: string;
  }): Promise<GithubInstallationMetadata>;
  verifyInstallationOwner(input: {
    userToken: string;
    installation: GithubInstallationMetadata;
  }): Promise<{ githubLogin: string }>;
  logger: WebhookLogger;
}

export interface NangoWebhookRequest {
  rawBody: string;
  signature?: string;
}

export interface NangoWebhookResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

class NangoConnectionOwnershipError extends Error {
  constructor() {
    super('Nango connection ownership does not match.');
    this.name = 'NangoConnectionOwnershipError';
  }
}

const nangoWebhookSchema = z
  .object({
    type: z.string(),
    operation: z.string().optional(),
    connectionId: z.string().min(1).optional(),
    authMode: z.string().optional(),
    providerConfigKey: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    environment: z.string().optional(),
    success: z.boolean().optional(),
    tags: z.record(z.string(), z.string()).optional(),
    error: z
      .object({
        type: z.string().optional(),
        description: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function sameAccountTags(
  first: ReturnType<typeof parseAccountNangoTags>,
  second: ReturnType<typeof parseAccountNangoTags>,
): boolean {
  return Boolean(
    first &&
      second &&
      first.accountId === second.accountId &&
      first.userId === second.userId &&
      first.purpose === second.purpose &&
      first.displayName === second.displayName &&
      first.connectAttemptId === second.connectAttemptId,
  );
}

function summaryMatchesAccountEvent(
  connection: NangoConnectionSummary,
  event: z.infer<typeof nangoWebhookSchema>,
  accountIntegrationId: string,
): boolean {
  if (
    connection.connectionId !== event.connectionId ||
    connection.integrationId !== accountIntegrationId ||
    connection.provider !== 'github-app-oauth'
  ) {
    return false;
  }
  return sameAccountTags(parseAccountNangoTags(event.tags), parseAccountNangoTags(connection.tags));
}

function existingConnectionMatches(
  existing: StoredAccountConnection,
  input: {
    accountId: string;
    connectionId: string;
    integrationId: string;
    installation: GithubInstallationMetadata;
  },
): boolean {
  return (
    existing.accountId === input.accountId &&
    existing.connectionId === input.connectionId &&
    existing.integrationId === input.integrationId &&
    existing.installationId === input.installation.installationId &&
    existing.ownerLogin.toLowerCase() === input.installation.ownerLogin.toLowerCase() &&
    existing.ownerType === input.installation.ownerType
  );
}

export function verifyNangoWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  signingKey: string,
): boolean {
  if (!signingKey || !signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', signingKey).update(rawBody).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createNangoWebhookHandler(
  dependencies: NangoWebhookHandlerDependencies,
): (request: NangoWebhookRequest) => Promise<NangoWebhookResult> {
  return async ({ rawBody, signature }) => {
    if (!verifyNangoWebhookSignature(rawBody, signature, dependencies.signingKey)) {
      return {
        status: 401,
        body: { ok: false, error: 'invalid_webhook_signature' },
      };
    }

    let rawEvent: unknown;
    try {
      rawEvent = JSON.parse(rawBody);
    } catch {
      return {
        status: 400,
        body: { ok: false, error: 'invalid_webhook_payload' },
      };
    }
    const parsed = nangoWebhookSchema.safeParse(rawEvent);
    if (!parsed.success) {
      return {
        status: 400,
        body: { ok: false, error: 'invalid_webhook_payload' },
      };
    }
    const event = parsed.data;

    if (event.type !== 'auth') {
      return {
        status: 200,
        body: { ok: true, ignored: true, reason: 'unsupported_event' },
      };
    }
    if (event.provider === 'github-app-oauth' && !dependencies.accountIntegrationId) {
      return {
        status: 503,
        body: {
          ok: false,
          error: 'nango_account_integration_not_configured',
        },
      };
    }
    if (event.provider === 'github-app' && !dependencies.managedIntegrationId) {
      return {
        status: 503,
        body: {
          ok: false,
          error: 'nango_managed_integration_not_configured',
        },
      };
    }

    const accountTags = parseAccountNangoTags(event.tags);
    const managedTags = parseManagedNangoTags(event.tags);
    const managedEvent =
      event.providerConfigKey === dependencies.managedIntegrationId &&
      event.provider === 'github-app' &&
      event.authMode === 'APP' &&
      managedTags !== null;
    if (managedEvent) {
      return {
        status: 200,
        body: {
          ok: true,
          ignored: true,
          reason: 'managed_connection_selection_required',
        },
      };
    }
    const accountEvent =
      event.providerConfigKey === dependencies.accountIntegrationId &&
      event.provider === 'github-app-oauth' &&
      event.authMode === 'CUSTOM' &&
      accountTags !== null;

    if (!accountEvent) {
      return {
        status: 200,
        body: { ok: true, ignored: true, reason: 'unrecognized_connection' },
      };
    }

    const connectionId = event.connectionId;
    if (!connectionId) {
      return {
        status: 200,
        body: { ok: true, ignored: true, reason: 'unrecognized_connection' },
      };
    }

    let storedConnection: StoredAccountConnection | null = null;
    try {
      if (
        (event.operation === 'creation' || event.operation === 'override') &&
        event.success === true
      ) {
        const authorized = await dependencies.authorizeAccountConnection({
          accountId: accountTags.accountId,
          userId: accountTags.userId,
        });
        if (!authorized) {
          return {
            status: 200,
            body: {
              ok: true,
              ignored: true,
              reason: 'account_authorization_expired',
            },
          };
        }
        const current = await dependencies.client.getConnection({
          connectionId,
          integrationId: dependencies.accountIntegrationId,
        });
        if (!summaryMatchesAccountEvent(current, event, dependencies.accountIntegrationId)) {
          return {
            status: 200,
            body: { ok: true, ignored: true, reason: 'unrecognized_connection' },
          };
        }

        const credential = decodeAccountGithubConnection(current, {
          integrationId: dependencies.accountIntegrationId,
        });
        const existing = await dependencies.store.findAccountConnection(connectionId);
        if (
          existing &&
          (existing.accountId !== accountTags.accountId ||
            existing.integrationId !== dependencies.accountIntegrationId)
        ) {
          return {
            status: 200,
            body: { ok: true, ignored: true, reason: 'ownership_mismatch' },
          };
        }
        storedConnection = existing;
        if (existing && existing.installationId !== credential.installationId) {
          const result = await dependencies.store.markNeedsReconnect({
            accountId: existing.accountId,
            connectionId,
            integrationId: existing.integrationId,
            errorCode: 'nango_connection_identity_changed',
          });
          dependencies.logger.warn('Nango GitHub connection identity changed', {
            connection_id: connectionId,
            account_id: existing.accountId,
            changed_project_count: result.changedProjectCount,
          });
          return {
            status: 200,
            body: {
              ok: true,
              ignored: true,
              reason: 'connection_identity_changed',
              changed_project_count: result.changedProjectCount,
            },
          };
        }

        const installation = await dependencies.inspectInstallation({
          userToken: credential.userToken,
          installationId: credential.installationId,
        });
        if (installation.installationId !== credential.installationId) {
          return {
            status: 200,
            body: { ok: true, ignored: true, reason: 'installation_mismatch' },
          };
        }

        await dependencies.verifyInstallationOwner({
          userToken: credential.userToken,
          installation,
        });

        if (
          existing &&
          !existingConnectionMatches(existing, {
            accountId: accountTags.accountId,
            connectionId,
            integrationId: dependencies.accountIntegrationId,
            installation,
          })
        ) {
          const result = await dependencies.store.markNeedsReconnect({
            accountId: existing.accountId,
            connectionId,
            integrationId: existing.integrationId,
            errorCode: 'nango_connection_identity_changed',
          });
          dependencies.logger.warn('Nango GitHub connection identity changed', {
            connection_id: connectionId,
            account_id: existing.accountId,
            changed_project_count: result.changedProjectCount,
          });
          return {
            status: 200,
            body: {
              ok: true,
              ignored: true,
              reason: 'connection_identity_changed',
              changed_project_count: result.changedProjectCount,
            },
          };
        }

        const result = await dependencies.store.reconcileAccountConnection({
          accountId: accountTags.accountId,
          initiatingUserId: accountTags.userId,
          connectAttemptId: accountTags.connectAttemptId,
          connectionId,
          integrationId: dependencies.accountIntegrationId,
          installation,
        });
        dependencies.logger.info('Nango GitHub connection reconciled', {
          connection_id: connectionId,
          operation: event.operation,
          account_id: accountTags.accountId,
          installation_id: installation.installationId,
          changed_project_count: result.changedProjectCount,
        });
        return {
          status: 200,
          body: {
            ok: true,
            operation: event.operation,
            connection_id: connectionId,
            changed_project_count: result.changedProjectCount,
          },
        };
      }

      if (event.operation === 'refresh' && event.success === false) {
        const connections = await dependencies.client.listConnections({
          connectionId,
          tags: event.tags,
          limit: 100,
        });
        const current = connections.find((connection) =>
          summaryMatchesAccountEvent(connection, event, dependencies.accountIntegrationId),
        );
        if (!current) {
          return {
            status: 200,
            body: { ok: true, ignored: true, reason: 'unrecognized_connection' },
          };
        }
        const existing = await dependencies.store.findAccountConnection(connectionId);
        if (
          !existing ||
          existing.accountId !== accountTags.accountId ||
          existing.integrationId !== dependencies.accountIntegrationId
        ) {
          return {
            status: 200,
            body: { ok: true, ignored: true, reason: 'unrecognized_connection' },
          };
        }
        const result = await dependencies.store.markNeedsReconnect({
          accountId: accountTags.accountId,
          connectionId,
          integrationId: dependencies.accountIntegrationId,
          errorCode: 'nango_refresh_failed',
        });
        dependencies.logger.warn('Nango GitHub connection requires reconnect', {
          connection_id: connectionId,
          account_id: accountTags.accountId,
          changed_project_count: result.changedProjectCount,
        });
        return {
          status: 200,
          body: {
            ok: true,
            operation: 'refresh',
            connection_id: connectionId,
            changed_project_count: result.changedProjectCount,
          },
        };
      }

      return {
        status: 200,
        body: { ok: true, ignored: true, reason: 'unsupported_auth_operation' },
      };
    } catch (error) {
      if (error instanceof NangoConnectionOwnershipError) {
        return {
          status: 200,
          body: { ok: true, ignored: true, reason: 'ownership_mismatch' },
        };
      }
      if (error instanceof GitHubInstallationAuthorizationError) {
        let changedProjectCount: number | undefined;
        if (storedConnection) {
          try {
            const result = await dependencies.store.markNeedsReconnect({
              accountId: storedConnection.accountId,
              connectionId,
              integrationId: storedConnection.integrationId,
              errorCode: 'nango_installation_owner_not_authorized',
            });
            changedProjectCount = result.changedProjectCount;
          } catch {
            dependencies.logger.error('Failed to invalidate rejected Nango GitHub connection', {
              connection_id: connectionId,
              account_id: storedConnection.accountId,
            });
            return {
              status: 500,
              body: { ok: false, error: 'webhook_reconciliation_failed' },
            };
          }
        }
        dependencies.logger.warn('Nango GitHub installation owner authorization rejected', {
          connection_id: connectionId,
          account_id: accountTags.accountId,
          ...(changedProjectCount !== undefined
            ? { changed_project_count: changedProjectCount }
            : {}),
        });
        return {
          status: 200,
          body: {
            ok: true,
            ignored: true,
            reason: 'installation_owner_not_authorized',
            ...(changedProjectCount !== undefined
              ? { changed_project_count: changedProjectCount }
              : {}),
          },
        };
      }
      if (isNangoError(error)) {
        dependencies.logger.warn('Nango webhook reconciliation provider failure', {
          connection_id: connectionId,
          code: error.code,
        });
        return {
          status: error.status,
          ...(error.retryAfter ? { headers: { 'retry-after': error.retryAfter } } : {}),
          body: { ok: false, error: error.code },
        };
      }
      dependencies.logger.error('Nango webhook reconciliation failed', {
        connection_id: connectionId,
        operation: event.operation,
      });
      return {
        status: 500,
        body: { ok: false, error: 'webhook_reconciliation_failed' },
      };
    }
  };
}

export const postgresNangoGithubConnectionStore: NangoGithubConnectionStore = {
  findAccountConnection: async (connectionId) => {
    const [row] = await db
      .select({
        accountId: accountGithubInstallations.accountId,
        installationId: accountGithubInstallations.installationId,
        connectionId: accountGithubInstallations.nangoConnectionId,
        integrationId: accountGithubInstallations.nangoIntegrationId,
        ownerLogin: accountGithubInstallations.ownerLogin,
        ownerType: accountGithubInstallations.ownerType,
        status: accountGithubInstallations.connectionStatus,
      })
      .from(accountGithubInstallations)
      .where(eq(accountGithubInstallations.nangoConnectionId, connectionId))
      .limit(1);
    if (!row?.connectionId || !row.integrationId) return null;
    return {
      ...row,
      connectionId: row.connectionId,
      integrationId: row.integrationId,
    };
  },

  reconcileAccountConnection: async (input) =>
    db.transaction(async (tx) => {
      const [existingByConnection] = await tx
        .select({
          accountId: accountGithubInstallations.accountId,
          installationId: accountGithubInstallations.installationId,
          ownerLogin: accountGithubInstallations.ownerLogin,
          ownerType: accountGithubInstallations.ownerType,
        })
        .from(accountGithubInstallations)
        .where(eq(accountGithubInstallations.nangoConnectionId, input.connectionId))
        .limit(1);
      if (
        existingByConnection &&
        (existingByConnection.accountId !== input.accountId ||
          existingByConnection.installationId !== input.installation.installationId ||
          existingByConnection.ownerLogin.toLowerCase() !==
            input.installation.ownerLogin.toLowerCase() ||
          existingByConnection.ownerType !== input.installation.ownerType)
      ) {
        throw new NangoConnectionOwnershipError();
      }

      const [existingInstallation] = await tx
        .select({
          connectionId: accountGithubInstallations.nangoConnectionId,
          connectionStatus: accountGithubInstallations.connectionStatus,
        })
        .from(accountGithubInstallations)
        .where(
          and(
            eq(accountGithubInstallations.accountId, input.accountId),
            eq(accountGithubInstallations.installationId, input.installation.installationId),
          ),
        )
        .limit(1);
      if (
        existingInstallation?.connectionId &&
        existingInstallation.connectionId !== input.connectionId &&
        existingInstallation.connectionStatus !== 'disconnected'
      ) {
        throw new NangoConnectionOwnershipError();
      }

      const now = new Date();
      await tx
        .insert(accountGithubInstallations)
        .values({
          accountId: input.accountId,
          installationId: input.installation.installationId,
          nangoConnectionId: input.connectionId,
          nangoIntegrationId: input.integrationId,
          connectionStatus: 'connected',
          lastValidatedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          disconnectedAt: null,
          ownerLogin: input.installation.ownerLogin,
          ownerType: input.installation.ownerType,
          repositorySelection: input.installation.repositorySelection ?? null,
          permissions: input.installation.permissions,
          metadata: {
            html_url: input.installation.installationUrl ?? null,
            connection_provider: 'nango',
            connect_attempt_id: input.connectAttemptId,
            linked_by_user_id: input.initiatingUserId,
          },
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [accountGithubInstallations.accountId, accountGithubInstallations.installationId],
          set: {
            nangoConnectionId: input.connectionId,
            nangoIntegrationId: input.integrationId,
            connectionStatus: 'connected',
            lastValidatedAt: now,
            lastErrorCode: null,
            lastErrorMessage: null,
            disconnectedAt: null,
            ownerLogin: input.installation.ownerLogin,
            ownerType: input.installation.ownerType,
            repositorySelection: input.installation.repositorySelection ?? null,
            permissions: input.installation.permissions,
            metadata: {
              html_url: input.installation.installationUrl ?? null,
              connection_provider: 'nango',
              connect_attempt_id: input.connectAttemptId,
              linked_by_user_id: input.initiatingUserId,
            },
            updatedAt: now,
          },
        });

      const changedProjects = await tx
        .update(projectGitConnections)
        .set({
          authMethod: 'nango',
          credentialRef: input.connectionId,
          status: 'connected',
          lastValidatedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(projectGitConnections.accountId, input.accountId),
            eq(projectGitConnections.installationId, input.installation.installationId),
            eq(projectGitConnections.provider, 'github'),
          ),
        )
        .returning({ connectionId: projectGitConnections.connectionId });

      return { changedProjectCount: changedProjects.length };
    }),

  markNeedsReconnect: async (input) =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          accountId: accountGithubInstallations.accountId,
          integrationId: accountGithubInstallations.nangoIntegrationId,
        })
        .from(accountGithubInstallations)
        .where(eq(accountGithubInstallations.nangoConnectionId, input.connectionId))
        .limit(1);
      if (
        !existing ||
        existing.accountId !== input.accountId ||
        existing.integrationId !== input.integrationId
      ) {
        throw new NangoConnectionOwnershipError();
      }

      const now = new Date();
      await tx
        .update(accountGithubInstallations)
        .set({
          connectionStatus: 'needs_reconnect',
          lastValidatedAt: now,
          lastErrorCode: input.errorCode,
          lastErrorMessage: 'GitHub authorization must be reconnected.',
          updatedAt: now,
        })
        .where(
          and(
            eq(accountGithubInstallations.accountId, input.accountId),
            eq(accountGithubInstallations.nangoConnectionId, input.connectionId),
          ),
        );

      const changedProjects = await tx
        .update(projectGitConnections)
        .set({
          status: 'needs_reconnect',
          lastValidatedAt: now,
          lastErrorCode: input.errorCode,
          lastErrorMessage: 'GitHub authorization must be reconnected.',
          updatedAt: now,
        })
        .where(
          and(
            eq(projectGitConnections.accountId, input.accountId),
            eq(projectGitConnections.credentialRef, input.connectionId),
            eq(projectGitConnections.provider, 'github'),
          ),
        )
        .returning({ connectionId: projectGitConnections.connectionId });

      return { changedProjectCount: changedProjects.length };
    }),
};

function toInstallationMetadata(installation: GitHubAppInstallation): GithubInstallationMetadata {
  const installationId = String(installation.id);
  const ownerLogin = installation.account?.login?.trim();
  const ownerType = installation.account?.type ?? installation.target_type;
  if (!installationId || !ownerLogin || (ownerType !== 'User' && ownerType !== 'Organization')) {
    throw new Error('GitHub installation metadata is incomplete.');
  }
  return {
    installationId,
    ownerLogin,
    ownerType,
    ...(installation.repository_selection
      ? { repositorySelection: installation.repository_selection }
      : {}),
    permissions: installation.permissions ?? {},
    ...(installation.html_url ? { installationUrl: installation.html_url } : {}),
  };
}

let productionHandler: ((request: NangoWebhookRequest) => Promise<NangoWebhookResult>) | null =
  null;

function getProductionHandler() {
  if (!productionHandler) {
    const client = createNangoClient({
      apiKey: config.NANGO_API_KEY,
      baseUrl: config.NANGO_BASE_URL,
    });
    productionHandler = createNangoWebhookHandler({
      signingKey: config.NANGO_WEBHOOK_SIGNING_KEY,
      accountIntegrationId: config.NANGO_GITHUB_ACCOUNT_INTEGRATION_ID,
      managedIntegrationId: config.NANGO_GITHUB_MANAGED_INTEGRATION_ID,
      client,
      store: postgresNangoGithubConnectionStore,
      authorizeAccountConnection: async ({ accountId, userId }) =>
        (await authorize(userId, accountId, ACCOUNT_ACTIONS.PROJECT_CREATE)).allowed,
      inspectInstallation: async ({ userToken, installationId }) =>
        toInstallationMetadata(
          await getGitHubAppInstallationForUserToken(userToken, installationId),
        ),
      verifyInstallationOwner: async ({ userToken, installation }) => {
        const githubInstallation: GitHubAppInstallation = {
          id: Number(installation.installationId),
          account: {
            login: installation.ownerLogin,
            type: installation.ownerType,
          },
          target_type: installation.ownerType,
          repository_selection: installation.repositorySelection,
          permissions: installation.permissions,
          html_url: installation.installationUrl,
        };
        const result = await verifyGitHubInstallationAdmin(userToken, githubInstallation);
        return { githubLogin: result.login };
      },
      logger: appLogger,
    });
  }
  return productionHandler;
}

class BodyTooLargeError extends Error {}

export async function readNangoWebhookBody(
  request: Request,
  limit = NANGO_WEBHOOK_MAX_BODY_BYTES,
): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new BodyTooLargeError();
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export const nangoWebhookApp = makeOpenApiApp();

const nangoWebhookResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  ignored: z.boolean().optional(),
  reason: z.string().optional(),
  operation: z.string().optional(),
  connection_id: z.string().optional(),
  changed_project_count: z.number().int().nonnegative().optional(),
});

nangoWebhookApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['webhooks'],
    summary: 'Nango auth lifecycle webhook (HMAC-SHA-256, public)',
    responses: {
      200: json(nangoWebhookResponseSchema, 'Webhook processing result'),
      ...errors(400, 401, 413, 429, 500, 502, 503),
    },
  }),
  async (c) => {
    if (
      !config.NANGO_API_KEY ||
      !config.NANGO_WEBHOOK_SIGNING_KEY ||
      (!config.NANGO_GITHUB_ACCOUNT_INTEGRATION_ID && !config.NANGO_GITHUB_MANAGED_INTEGRATION_ID)
    ) {
      return c.json({ ok: false, error: 'nango_not_configured' }, 503);
    }

    let rawBody: string;
    try {
      rawBody = await readNangoWebhookBody(c.req.raw);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return c.json({ ok: false, error: 'webhook_payload_too_large' }, 413);
      }
      throw error;
    }

    const result = await getProductionHandler()({
      rawBody,
      signature: c.req.header('X-Nango-Hmac-Sha256'),
    });
    if (result.headers?.['retry-after']) {
      c.header('Retry-After', result.headers['retry-after']);
    }
    const responseBody = nangoWebhookResponseSchema.parse(result.body);
    if (result.status === 429) {
      return c.json(responseBody, 429);
    }
    switch (result.status) {
      case 200:
        return c.json(responseBody, 200);
      case 400:
        return c.json(responseBody, 400);
      case 401:
        return c.json(responseBody, 401);
      case 413:
        return c.json(responseBody, 413);
      case 500:
        return c.json(responseBody, 500);
      case 502:
        return c.json(responseBody, 502);
      case 503:
        return c.json(responseBody, 503);
      default:
        return c.json({ ok: false, error: 'webhook_reconciliation_failed' }, 500);
    }
  },
);

/** Actions on one connector connection: rename, credential, revoke, activate, default, connect. */
import { createRoute, z } from '@hono/zod-openapi';
import {
  RenameConnectionInputSchema,
  UpdateConnectionCredentialInputSchema,
} from '@kortix/api-contract';
import { connectorConnections, connectors } from '@kortix/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  connectionIsEffectiveProjectDefault,
  resolveConnectionCredentialValue,
  upsertConnectionCredential,
  upsertConnectionOAuth2Credential,
} from '../../connectors/credentials';
import { connectedAsOf, validateConnectionLabel } from '../../connectors/connection-identity';
import { revokeConnectionOAuth2 } from '../../connectors/oauth2-store';
import { composioConfigured } from '../../connectors/composio';
import {
  finalizePipedreamConnectionAuthorization,
  pipedreamConfigured,
  pipedreamConnectUrl,
} from '../../connectors/pipedream';
import { rematerializeCatalogAfterCredentialUpdate } from '../../connectors/sync';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { isUniqueViolation } from '../../shared/postgres-errors';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  type ConnectionOwnerType,
  connectionIsReachable,
  isTrustedManagedChannelAuthorization,
} from '../lib/connection-access';
import { requestAgentPrincipalReach } from '../lib/personal-resources';
import { readJsonObject } from '../../shared/http-body';
import { ConnectionViewSchema, serializeConnection } from '../lib/connection-view';

type AgentPrincipalReach = Awaited<ReturnType<typeof requestAgentPrincipalReach>>;

function mayMutateConnection(
  connection: {
    ownerType: ConnectionOwnerType;
    ownerId: string | null;
    metadata: Record<string, unknown>;
    providerType: string;
    connectorConfig: Record<string, unknown>;
  },
  userId: string,
  actingPrincipalIsServiceAccount: boolean,
  mayManageSystemConnections: boolean,
  /** Agent-principal reach (spec 2026-09-22 §2.3); null = legacy rule. */
  agentPrincipal: AgentPrincipalReach | null = null,
): boolean {
  const reachable = connectionIsReachable({
    ownerType: connection.ownerType,
    ownerId: connection.ownerId,
    actingUserId: userId,
    actingPrincipalIsServiceAccount,
    agentPrincipal,
    trustedManagedSystem: isTrustedManagedChannelAuthorization({
      providerType: connection.providerType,
      platform:
        typeof connection.connectorConfig.platform === 'string'
          ? connection.connectorConfig.platform
          : null,
      ownerType: connection.ownerType,
      ownerId: connection.ownerId,
      metadata: connection.metadata,
    }),
  });
  if (!reachable) return false;
  // Your own private account is yours to administer — reachability already
  // proved the owner is the caller. Everything shared with the project is
  // administration and needs the connections-manage capability.
  return connection.ownerType === 'member' || mayManageSystemConnections;
}

/**
 * The connection a caller may mutate, or `null`. `null` answers 404 so a
 * caller cannot probe for connections they cannot reach. A member may always
 * mutate their own private connection. Every other connection needs
 * `project.connector.connections.manage`.
 */
async function loadMutableConnection(
  c: any,
  loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>,
  projectId: string,
  connectionId: string,
) {
  const actingPrincipalIsServiceAccount = c.get('authType') === 'service_account';
  const mayManageSystemConnections = await projectCapabilityAllowed(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
  );
  const [connection] = await db
    .select({
      connectorId: connectorConnections.connectorId,
      ownerType: connectorConnections.ownerType,
      ownerId: connectorConnections.ownerId,
      isDefault: connectorConnections.isDefault,
      label: connectorConnections.label,
      metadata: connectorConnections.metadata,
      providerType: connectors.providerType,
      connectorConfig: connectors.config,
      connectorAlias: connectors.slug,
      status: connectorConnections.status,
    })
    .from(connectorConnections)
    .innerJoin(
      connectors,
      and(
        eq(connectors.connectorId, connectorConnections.connectorId),
        eq(connectors.accountId, connectorConnections.accountId),
        eq(connectors.projectId, connectorConnections.projectId),
      ),
    )
    .where(
      and(
        eq(connectorConnections.connectionId, connectionId),
        eq(connectorConnections.projectId, projectId),
        eq(connectorConnections.accountId, loaded.row.accountId),
      ),
    )
    .limit(1);
  if (!connection) return null;
  if (
    !mayMutateConnection(
      connection,
      loaded.userId,
      actingPrincipalIsServiceAccount,
      mayManageSystemConnections,
      await requestAgentPrincipalReach(c, loaded.actor),
    )
  ) {
    return null;
  }
  return connection;
}

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/connections/{connectionId}/label',
    tags: ['connectors'],
    summary: 'Rename connection',
    description:
      'Change the label only. The authorized account, owner, default flag, and provider state stay as they are.',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), connectionId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: RenameConnectionInputSchema } } },
    },
    responses: {
      200: json(ConnectionViewSchema, 'Renamed connection'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    const body = await readJsonObject(c);
    const validated = validateConnectionLabel(body?.label);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const connection = await loadMutableConnection(c, loaded, projectId, connectionId);
    if (!connection) return c.json({ error: 'Not found' }, 404);
    const label = validated.label;
    if (label === connection.label) {
      return c.json(serializeConnection({ ...connection, connectionId }), 200);
    }
    // `--account <label>` matches case-insensitively, so two accounts of one
    // owner that differ only by case could not be told apart. The unique
    // index is case-sensitive, so this check is the one that refuses them.
    const [clash] = await db
      .select({ connectionId: connectorConnections.connectionId })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.connectorId, connection.connectorId),
          eq(connectorConnections.ownerType, connection.ownerType),
          connection.ownerId === null
            ? isNull(connectorConnections.ownerId)
            : eq(connectorConnections.ownerId, connection.ownerId),
          ne(connectorConnections.connectionId, connectionId),
          sql`lower(btrim(${connectorConnections.label})) = ${label.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (clash) {
      return c.json({ error: `Another account of this connector is already named "${label}"` }, 409);
    }
    try {
      // `updatedAt` stays as it is on purpose. Composio finalize picks the
      // most recently updated row of an owner as the one a connect just
      // started, so bumping it here could redirect an in-flight authorization.
      await db
        .update(connectorConnections)
        .set({ label })
        .where(eq(connectorConnections.connectionId, connectionId));
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: `Another account of this connector is already named "${label}"` }, 409);
      }
      throw error;
    }
    return c.json(serializeConnection({ ...connection, connectionId, label }), 200);
  },
);

for (const operation of ['credential', 'revoke', 'activate', 'default'] as const) {
  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: `/{projectId}/connections/{connectionId}/${operation}`,
      tags: ['connectors'],
      summary: `${operation} connection`,
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), connectionId: z.string().uuid() }),
        body: {
          content: {
            'application/json': {
              schema:
                operation === 'credential'
                  ? UpdateConnectionCredentialInputSchema
                  : z.object({}).strict(),
            },
          },
        },
      },
      responses: {
        200: json(z.object({ ok: z.literal(true) }), 'Updated'),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const connectionId = c.req.param('connectionId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const connection = await loadMutableConnection(c, loaded, projectId, connectionId);
      if (!connection) return c.json({ error: 'Not found' }, 404);
      if (operation === 'credential') {
        const body = await readJsonObject(c);
        const parsed = UpdateConnectionCredentialInputSchema.safeParse(body);
        if (!parsed.success) {
          return c.json(
            {
              error:
                body?.oauth2 != null
                  ? (parsed.error.issues[0]?.message ?? 'invalid OAuth2 credential')
                  : 'value is required',
            },
            400,
          );
        }
        try {
          if ('oauth2' in parsed.data) {
            await upsertConnectionOAuth2Credential({
              projectId,
              connectorId: connection.connectorId,
              connectionId,
              oauth2: parsed.data.oauth2,
              createdBy: loaded.userId,
            });
          } else {
            await upsertConnectionCredential({
              projectId,
              connectorId: connection.connectorId,
              connectionId,
              value: parsed.data.value,
              kind: parsed.data.kind,
              createdBy: loaded.userId,
            });
          }
        } catch (error) {
          return c.json({ error: (error as Error).message || 'credential validation failed' }, 400);
        }
        // INVARIANT (2026-09-16, account_required rule): `connection.isDefault`
        // is the raw (possibly unpinned) row flag; the project-wide catalog
        // write below must key on the EFFECTIVE default — pinned, or the
        // connector's sole active project-owned connection — so setting a
        // credential on a never-pinned solo MCP connection still publishes
        // exactly as it did before this rule existed.
        const isEffectiveDefault =
          connection.isDefault ||
          (connection.ownerType === 'project' &&
            (await connectionIsEffectiveProjectDefault(connection.connectorId, connectionId)));
        await rematerializeCatalogAfterCredentialUpdate({
          projectId,
          accountId: loaded.row.accountId,
          provider: connection.providerType,
          ownerType: connection.ownerType,
          isDefault: isEffectiveDefault,
          connectorId: connection.connectorId,
          credential:
            connection.providerType === 'mcp' &&
            connection.ownerType === 'project' &&
            isEffectiveDefault
              ? await resolveConnectionCredentialValue({
                  connectorId: connection.connectorId,
                  connectionId,
                })
              : null,
        });
      } else if (operation === 'default') {
        // Make THIS the default connection for its owner scope. Defaults are
        // per-owner (one team default; one per member), and the partial unique
        // indexes enforce that — so clear the current default in the SAME scope
        // first, in one transaction, or the update would collide.
        await db.transaction(async (tx) => {
          const sameScope = and(
            eq(connectorConnections.connectorId, connection.connectorId),
            eq(connectorConnections.ownerType, connection.ownerType),
            connection.ownerId === null
              ? isNull(connectorConnections.ownerId)
              : eq(connectorConnections.ownerId, connection.ownerId),
          );
          await tx
            .update(connectorConnections)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(and(sameScope, eq(connectorConnections.isDefault, true)));
          await tx
            .update(connectorConnections)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(connectorConnections.connectionId, connectionId));
        });
        await rematerializeCatalogAfterCredentialUpdate({
          projectId,
          accountId: loaded.row.accountId,
          provider: connection.providerType,
          ownerType: connection.ownerType,
          isDefault: true,
          connectorId: connection.connectorId,
          credential:
            connection.providerType === 'mcp' && connection.ownerType === 'project'
              ? await resolveConnectionCredentialValue({
                  connectorId: connection.connectorId,
                  connectionId,
                })
              : null,
        });
      } else {
        if (operation === 'revoke') await revokeConnectionOAuth2(connectionId);
        await db
          .update(connectorConnections)
          .set({ status: operation === 'revoke' ? 'revoked' : 'active', updatedAt: new Date() })
          .where(eq(connectorConnections.connectionId, connectionId));
      }
      return c.json({ ok: true });
    },
  );
}

for (const operation of ['connect', 'connect/finalize'] as const) {
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: `/{projectId}/connections/{connectionId}/${operation}`,
      tags: ['connectors'],
      summary:
        operation === 'connect'
          ? 'Start Pipedream OAuth for a connection'
          : 'Finalize Pipedream OAuth for a connection',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), connectionId: z.string().uuid() }),
        body: {
          content: {
            'application/json': {
              schema:
                operation === 'connect'
                  ? z
                      .object({
                        success_redirect_uri: z.string().optional(),
                        error_redirect_uri: z.string().optional(),
                      })
                      .strict()
                  : z.object({}).strict(),
            },
          },
        },
      },
      responses: {
        200: json(z.any(), 'Pipedream connection result'),
        ...errors(400, 403, 404, 409, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const connectionId = c.req.param('connectionId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const actingPrincipalIsServiceAccount = c.get('authType') === 'service_account';
      const mayManageSystemConnections = await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
      );
      const [connection] = await db
        .select({
          connectorId: connectorConnections.connectorId,
          ownerType: connectorConnections.ownerType,
          ownerId: connectorConnections.ownerId,
          isDefault: connectorConnections.isDefault,
          metadata: connectorConnections.metadata,
          connectorAlias: connectors.slug,
          providerType: connectors.providerType,
          connectorConfig: connectors.config,
          })
        .from(connectorConnections)
        .innerJoin(
          connectors,
          and(
            eq(connectors.connectorId, connectorConnections.connectorId),
            eq(connectors.accountId, connectorConnections.accountId),
            eq(connectors.projectId, connectorConnections.projectId),
          ),
        )
        .where(
          and(
            eq(connectorConnections.connectionId, connectionId),
            eq(connectorConnections.projectId, projectId),
            eq(connectorConnections.accountId, loaded.row.accountId),
          ),
        )
        .limit(1);
      if (
        !connection ||
        !mayMutateConnection(
          connection,
          loaded.userId,
          actingPrincipalIsServiceAccount,
          mayManageSystemConnections,
          await requestAgentPrincipalReach(c, loaded.actor),
        )
      ) {
        return c.json({ error: 'Not found' }, 404);
      }
      // INVARIANT (2026-09-16, account_required rule): a project-owned
      // connection with nothing PINNED is still blocked here when it is the
      // connector's sole active project-owned row — it is the connector's
      // EFFECTIVE default even unpinned, and must still go through the shared
      // connect endpoint. See `connectionIsEffectiveProjectDefault`.
      const isEffectiveDefault =
        connection.isDefault ||
        (connection.ownerType === 'project' &&
          (await connectionIsEffectiveProjectDefault(connection.connectorId, connectionId)));
      if (isEffectiveDefault) {
        return c.json(
          { error: 'Use the shared connector connect endpoint for the default connection' },
          409,
        );
      }
      // Provider-neutral, like the connector-scoped route and the connect-link
      // intake. This was Pipedream-only, so a Composio connector's labelled
      // (non-default) connection answered "not a pipedream connector" — the
      // multi-account path silently had no Composio support at all.
      if (!composioConfigured() && !pipedreamConfigured()) {
        return c.json({ error: 'no hosted connector authorization provider is configured' }, 501);
      }
      const app = (connection.connectorConfig as Record<string, unknown> | null)?.app;
      if (typeof app !== 'string' || !app) {
        return c.json({ error: 'connector names no provider app' }, 404);
      }
      if (connection.providerType === 'composio') {
        if (!composioConfigured()) return c.json({ error: 'composio not configured' }, 501);
        const {
          composioConnectUrl,
          finalizeComposioConnection,
          composioUserId,
          probeComposioIdentity,
        } = await import('../../connectors/composio');
        const { relabelToIdentity, resolveConnectedAs } = await import(
          '../../connectors/connection-identity'
        );
        const { composioConnectionMetadata } = await import('../../connectors/db-deps');
        const stableUserId = composioUserId(connectionId);
        const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
        if (operation === 'connect') {
          const body = await readJsonObject(c);
          const redirects =
            body.success_redirect_uri || body.error_redirect_uri
              ? {
                  success:
                    typeof body.success_redirect_uri === 'string'
                      ? body.success_redirect_uri
                      : undefined,
                  error:
                    typeof body.error_redirect_uri === 'string'
                      ? body.error_redirect_uri
                      : undefined,
                }
              : undefined;
          const result = await composioConnectUrl({
            projectId,
            slug: connection.connectorAlias,
            app,
            connectionId,
            stableUserId,
            redirects,
          });
          await db
            .update(connectorConnections)
            .set({
              status: 'active',
              metadata: composioConnectionMetadata({
                toolkit: app,
                stableUserId,
                sessionId: result.sessionId,
                authRequestId: result.authRequestId,
                connectedAccountId: result.connectedAccountId,
                isNoAuth: result.isNoAuth,
                previous: metadata,
                connectedAs:
                  result.connectedAccountId &&
                  result.connectedAccountId === metadata.connected_account_id
                    ? connectedAsOf(metadata)
                    : null,
              }),
              updatedAt: sql`now()`,
            })
            .where(eq(connectorConnections.connectionId, connectionId));
          return c.json({
            app,
            connectUrl: result.connectUrl,
            connected: result.connected,
            isNoAuth: result.isNoAuth,
          });
        }
        const sessionId = typeof metadata.session_id === 'string' ? metadata.session_id : '';
        if (!sessionId) return c.json({ connected: false });
        const result = await finalizeComposioConnection({
          projectId,
          slug: connection.connectorAlias,
          app,
          connectionId,
          stableUserId,
          sessionId,
          ...(typeof metadata.auth_request_id === 'string'
            ? { authRequestId: metadata.auth_request_id }
            : {}),
        });
        const connectedAs = result.connected
          ? await resolveConnectedAs({
              previous: metadata,
              connectedAccountId: result.connectedAccountId,
              isNoAuth: result.isNoAuth,
              probe: () =>
                probeComposioIdentity({
                  app,
                  sessionId: result.sessionId,
                  connectedAccountId: result.connectedAccountId!,
                }),
            })
          : null;
        await db
          .update(connectorConnections)
          .set({
            status: 'active',
            metadata: composioConnectionMetadata({
              toolkit: app,
              stableUserId,
              sessionId: result.sessionId,
              authRequestId: result.authRequestId,
              connectedAccountId: result.connectedAccountId,
              isNoAuth: result.isNoAuth,
              previous: metadata,
              connectedAs,
            }),
            updatedAt: sql`now()`,
          })
          .where(eq(connectorConnections.connectionId, connectionId));
        const label = connectedAs ? await relabelToIdentity({ connectionId, identity: connectedAs }) : null;
        return c.json({
          connected: result.connected,
          accountId: result.connectedAccountId,
          connected_as: connectedAs,
          ...(label ? { label } : {}),
        });
      }
      if (!pipedreamConfigured()) {
        return c.json({ error: 'pipedream not configured' }, 501);
      }
      if (connection.providerType !== 'pipedream') {
        return c.json({ error: 'not a pipedream connector' }, 404);
      }
      if (operation === 'connect') {
        const body = await readJsonObject(c);
        const redirects =
          body.success_redirect_uri || body.error_redirect_uri
            ? {
                success:
                  typeof body.success_redirect_uri === 'string'
                    ? body.success_redirect_uri
                    : undefined,
                error:
                  typeof body.error_redirect_uri === 'string' ? body.error_redirect_uri : undefined,
              }
            : undefined;
        const result = await pipedreamConnectUrl(
          projectId,
          connection.connectorAlias,
          app,
          connectionId,
          redirects,
        );
        return c.json({
          token: result.token,
          app,
          connectUrl: result.connectUrl,
          expiresAt: result.expiresAt,
        });
      }
      const result = await finalizePipedreamConnectionAuthorization({
        projectId,
        slug: connection.connectorAlias,
        app,
        connectorId: connection.connectorId,
        connectionId,
        createdBy: loaded.userId,
      });
      return c.json(result);
    },
  );
}

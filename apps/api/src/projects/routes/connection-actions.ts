/** Actions on one connector connection: rename, credential, revoke, activate, default, connect. */
import { createRoute, z } from '@hono/zod-openapi';
import {
  RenameConnectionInputSchema,
  UpdateConnectionCredentialInputSchema,
} from '@kortix/api-contract';
import { connectorConnections } from '@kortix/db';
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
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { isUniqueViolation } from '../../shared/postgres-errors';
import { projectsApp } from '../lib/app';
import { loadMutableConnection } from '../lib/connection-mutation';
import { readJsonObject } from '../../shared/http-body';
import { ConnectionViewSchema, serializeConnection } from '../lib/connection-view';
import { actorOf } from '../../iam/actor';
import { assignRole } from '../../iam/assignments';

const ShareConnectionInput = z
  .object({
    principals: z
      .array(
        z
          .object({
            principal_type: z.enum(['user', 'group', 'project']),
            principal_id: z.string().uuid(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connections/{connectionId}/share',
    tags: ['connectors'],
    summary: 'Share your own private connection',
    description:
      "Turn the caller's own private account into a shared account that only `principals` may " +
      'use (an empty list: everyone in the project). The grants are written first and the ' +
      'account becomes shared in one update, so it is never open to the whole project in ' +
      'between. Needs `project.connector.connections.manage`, the right to create a shared ' +
      'account. A shared account is managed by every connections manager from then on.',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), connectionId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: ShareConnectionInput } } },
    },
    responses: {
      200: json(ConnectionViewSchema, 'The shared connection'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const connectionId = c.req.param('connectionId');
    const parsed = ShareConnectionInput.safeParse(await readJsonObject(c));
    if (!parsed.success) {
      return c.json(
        { error: 'principals must be a list of { principal_type: user | group | project, principal_id }' },
        400,
      );
    }
    // Only the owner reaches their own private row here; anyone else gets null.
    const mutable = await loadMutableConnection(c, projectId, connectionId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    const { loaded, connection } = mutable;
    if (connection.ownerType === 'project') {
      return c.json(
        { error: 'This account is already shared. Change who can use it with its Share dialog or the grants API.' },
        409,
      );
    }
    if (connection.ownerType !== 'member' || connection.ownerId !== loaded.userId) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (!mutable.mayManageSystemConnections) {
      return c.json(
        { error: "Sharing an account needs permission to manage the project's connections" },
        403,
      );
    }
    const label = connection.label;
    const clashes = (other: { label: string }) =>
      c.json(
        { error: `A shared account of this connector is already named "${other.label}". Rename one first.` },
        409,
      );
    const [clash] = await db
      .select({ label: connectorConnections.label })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.connectorId, connection.connectorId),
          eq(connectorConnections.ownerType, 'project'),
          isNull(connectorConnections.ownerId),
          sql`lower(btrim(${connectorConnections.label})) = ${label.trim().toLowerCase()}`,
        ),
      )
      .limit(1);
    if (clash) return clashes({ label });

    // Grants first, on the still-private row, which ignores them. Each goes
    // through assignRole: principal checks, audit, cache invalidation.
    const writer = await actorOf(c, loaded.row.accountId);
    for (const principal of parsed.data.principals) {
      await assignRole(writer, loaded.row.accountId, {
        principal: { type: principal.principal_type, id: principal.principal_id },
        roleKey: 'agent-user',
        scope: { type: 'project', id: projectId },
        object: { type: 'connection', id: connectionId },
        privateConnectionOwnerId: loaded.userId,
        source: 'manual',
      });
    }
    // Then shared, in one update guarded on the row still being this owner's.
    // Not the default of the project's accounts: pinning one stays deliberate.
    let updated: Array<{ connectionId: string }>;
    try {
      updated = await db
        .update(connectorConnections)
        .set({ ownerType: 'project', ownerId: null, isDefault: false })
        .where(
          and(
            eq(connectorConnections.connectionId, connectionId),
            eq(connectorConnections.ownerType, 'member'),
            eq(connectorConnections.ownerId, loaded.userId),
          ),
        )
        .returning({ connectionId: connectorConnections.connectionId });
    } catch (error) {
      if (isUniqueViolation(error)) return clashes({ label });
      throw error;
    }
    if (updated.length === 0) {
      return c.json({ error: 'The account changed while it was being shared. Try again.' }, 409);
    }
    return c.json(
      serializeConnection({ ...connection, ownerType: 'project', ownerId: null, isDefault: false }),
      200,
    );
  },
);

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
    const validated = validateConnectionLabel(body.label);
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    const mutable = await loadMutableConnection(c, projectId, connectionId);
    if (!mutable) return c.json({ error: 'Not found' }, 404);
    const { connection } = mutable;
    const label = validated.label;
    if (label === connection.label) {
      return c.json(serializeConnection(connection), 200);
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
    return c.json(serializeConnection({ ...connection, label }), 200);
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
      const mutable = await loadMutableConnection(c, projectId, connectionId);
      if (!mutable) return c.json({ error: 'Not found' }, 404);
      const { loaded, connection } = mutable;
      if (operation === 'credential') {
        const body = await readJsonObject(c);
        const parsed = UpdateConnectionCredentialInputSchema.safeParse(body);
        if (!parsed.success) {
          return c.json(
            {
              error:
                body.oauth2 != null
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
      const mutable = await loadMutableConnection(c, projectId, connectionId);
      if (!mutable) return c.json({ error: 'Not found' }, 404);
      const { loaded, connection } = mutable;
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

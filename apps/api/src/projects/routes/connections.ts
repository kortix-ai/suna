/** Connector connections: list, roster, and create (own and project-shared). */
import { createRoute, z } from '@hono/zod-openapi';
import { ConnectionMetadataSchema, ReconcileConnectionInputSchema } from '@kortix/api-contract';
import { connectorConnections, connectors, projectSessionConnectorBindings } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { isUniqueViolation } from '../../shared/postgres-errors';
import {
  assertProjectCapability,
  loadProjectForUser,
  projectCapabilityAllowed,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import {
  type ConnectionAudienceReach,
  type ConnectionOwnerType,
  connectionIsReachable,
  isTrustedManagedChannelAuthorization,
} from '../lib/connection-access';
import { audiencePersonId, loadConnectionAudience } from '../lib/connection-audience';
import { loadConnectionSharing } from '../lib/connection-sharing';
import { sessionMayEnumerateConnection } from '../lib/connector-connection-visibility';
import { requestAgentPrincipalReach } from '../lib/personal-resources';
import { readJsonObject } from '../../shared/http-body';
import { canonicalConnectorAlias } from '../lib/session-connector-bindings';
import { ConnectionViewSchema, serializeConnection } from '../lib/connection-view';

type AgentPrincipalReach = Awaited<ReturnType<typeof requestAgentPrincipalReach>>;

/**
 * The owner/admin roster shape is narrower than Connection.
 * It answers "who has connected this connector, and does it still work?" and
 * nothing else. `label` and `metadata` are omitted on purpose: they are a
 * member's own annotations on a PRIVATE connection and can carry personal
 * identifiers (an email, an inbox id, a workspace id), which a peer manager has
 * no need to see. Credentials are never in any connection shape.
 */
const ConnectionRosterEntrySchema = z
  .object({
    connection_id: z.string().uuid(),
    connector_alias: z.string(),
    owner_type: z.enum(['project', 'agent', 'member', 'subject', 'external']),
    owner_id: z.string().nullable(),
    status: z.enum(['active', 'revoked', 'error']),
  })
  .openapi('ConnectionRosterEntry');

function mayReadConnection(
  connection: {
    connectionId: string;
    ownerType: ConnectionOwnerType;
    ownerId: string | null;
    isDefault: boolean;
    metadata: Record<string, unknown>;
    providerType: string;
    connectorConfig: Record<string, unknown>;
  },
  userId: string,
  actingPrincipalIsServiceAccount: boolean,
  /** Connection ids the CALLER'S session is bound to, or null when the caller is
   *  not session-bound. See connector-connection-visibility.ts: a sandbox's token
   *  carries the WRAPPER's user id, so without this every end-user's agent could
   *  enumerate every other end-user's connection and then bind it. */
  sessionBoundConnectionIds: ReadonlySet<string> | null,
  /** Agent-principal reach (spec 2026-09-22 §2.3); null = legacy rule. */
  agentPrincipal: AgentPrincipalReach | null,
  /** A shared account's audience for the person this call acts for. */
  audience: ConnectionAudienceReach,
): boolean {
  if (!sessionMayEnumerateConnection(connection, sessionBoundConnectionIds)) return false;
  return connectionIsReachable({
    ownerType: connection.ownerType,
    ownerId: connection.ownerId,
    actingUserId: userId,
    actingPrincipalIsServiceAccount,
    agentPrincipal,
    audience,
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
}

async function reconcileConnectionRow(input: {
  accountId: string;
  projectId: string;
  connectorId: string;
  ownerType: 'project' | 'agent' | 'member' | 'subject' | 'external';
  /** null for a `project` (team-shared) connection — the CHECK constraint
   *  requires owner_id IS NULL there; every other owner type carries an id. */
  ownerId: string | null;
  label: string;
  metadata: Record<string, unknown>;
  createdBy: string;
}) {
  // Identity includes the LABEL: an owner may hold several connections on one
  // connector ("Work", "Personal"), so reconciling a NEW label adds a connection
  // while the same label stays idempotent (updates metadata in place). Matches
  // idx_connector_connections_owner.
  const identity = and(
    eq(connectorConnections.connectorId, input.connectorId),
    eq(connectorConnections.ownerType, input.ownerType),
    input.ownerId === null
      ? isNull(connectorConnections.ownerId)
      : eq(connectorConnections.ownerId, input.ownerId),
    eq(connectorConnections.label, input.label),
  );
  const [existing] = await db.select().from(connectorConnections).where(identity).limit(1);
  if (existing) {
    // Reconciling the label of a REVOKED row is a re-connect, not a metadata
    // touch: the caller is adding "this account" back, and the credential they
    // set next must land on a live row. Left `revoked`, the row kept its new
    // credential but stayed invisible to every call and every list of usable
    // accounts (found 2026-09-17: header "Add credential" on a connector whose
    // only shared account had just been disconnected saved into a dead row).
    // `error` is a live-state flag the next sync owns; it is not cleared here.
    const [connection] = await db
      .update(connectorConnections)
      .set({
        label: input.label,
        metadata: input.metadata,
        ...(existing.status === 'revoked' ? { status: 'active' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(connectorConnections.connectionId, existing.connectionId))
      .returning();
    return { connection, created: false };
  }
  let inserted: typeof connectorConnections.$inferSelect | undefined;
  try {
    [inserted] = await db
      .insert(connectorConnections)
      .values({
        accountId: input.accountId,
        projectId: input.projectId,
        connectorId: input.connectorId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        label: input.label,
        metadata: input.metadata,
        createdBy: input.createdBy,
      })
      .returning();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  if (inserted) return { connection: inserted, created: true };
  const [raced] = await db.select().from(connectorConnections).where(identity).limit(1);
  return { connection: raced, created: false };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/connections',
    tags: ['connectors'],
    summary: 'List connections',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(z.object({ connections: z.array(ConnectionViewSchema) }), 'Connections'),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const actingPrincipalIsServiceAccount = c.get('authType') === 'service_account';
    const agentReach = await requestAgentPrincipalReach(c, loaded.actor);
    // A sandbox connector token is bound to ONE session. Load what that session was
    // actually GIVEN so the enumeration below can be narrowed to it. null for
    // every non-session caller, which leaves the operator's view unchanged.
    const callerSessionId = callerKortixSessionId(c);
    let sessionBoundConnectionIds: ReadonlySet<string> | null = null;
    if (callerSessionId) {
      const bound = await db
        .select({ connectionId: projectSessionConnectorBindings.connectionId })
        .from(projectSessionConnectorBindings)
        .where(
          and(
            eq(projectSessionConnectorBindings.sessionId, callerSessionId),
            eq(projectSessionConnectorBindings.projectId, projectId),
          ),
        );
      sessionBoundConnectionIds = new Set(bound.map((row) => row.connectionId));
    }
    const rows = await db
      .select({
        connectionId: connectorConnections.connectionId,
        connectorAlias: connectors.slug,
        ownerType: connectorConnections.ownerType,
        ownerId: connectorConnections.ownerId,
        label: connectorConnections.label,
        status: connectorConnections.status,
        isDefault: connectorConnections.isDefault,
        metadata: connectorConnections.metadata,
        providerType: connectors.providerType,
        connectorConfig: connectors.config,
      })
      .from(connectorConnections)
      .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
      .where(eq(connectorConnections.projectId, projectId));
    const audienceOf = await loadConnectionAudience({
      projectId,
      accountId: loaded.row.accountId,
      userId: audiencePersonId({
        actingUserId: loaded.userId,
        actingPrincipalIsServiceAccount,
        agentPrincipal: agentReach,
      }),
    });
    const listed = rows.map((connection) => {
      const audience = audienceOf(connection.connectionId);
      return {
        connection,
        audience,
        usable: mayReadConnection(
          connection,
          loaded.userId,
          actingPrincipalIsServiceAccount,
          sessionBoundConnectionIds,
          agentReach,
          audience,
        ),
      };
    });
    // A shared account narrowed to an audience the caller is outside of stays
    // listed for a person who manages the project's connections, marked
    // `usable: false`, so they can widen it again. A session-bound token (a
    // sandbox) never sees it: it could not use it anyway.
    const outsideAudience = listed.some(
      (item) => !item.usable && item.connection.ownerType === 'project' && item.audience === 'out',
    );
    const mayManage =
      outsideAudience &&
      !callerSessionId &&
      (await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
      ));
    const sharing = await loadConnectionSharing({
      projectId,
      accountId: loaded.row.accountId,
      projectName: loaded.row.name,
    });
    return c.json({
      connections: listed
        .filter(
          (item) =>
            item.usable ||
            (mayManage && item.connection.ownerType === 'project' && item.audience === 'out'),
        )
        .map((item) => ({
          ...serializeConnection(item.connection),
          ...(item.connection.ownerType === 'project'
            ? { shared_with: sharing.get(item.connection.connectionId) ?? [] }
            : {}),
          usable: item.usable,
        })),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/connections/all',
    tags: ['connectors'],
    summary: "List every member's connections",
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(
        z.object({ connections: z.array(ConnectionRosterEntrySchema) }),
        'Connection roster',
      ),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // A read-only roster of EVERY member's connection for this project: WHO has
    // connected which connector, and whether it still works. Manage-gated
    // (owner/manager), and deliberately NARROWER than the caller-scoped list —
    // it returns identity + status ONLY. `label` and `metadata` are excluded on
    // purpose: they are a member's own annotations on a PRIVATE connection and
    // can carry personal identifiers (an email, an inbox_id, a workspace id).
    // The plain list hides other members' connections entirely, so this route is
    // the one place peer rows are visible — it must disclose the minimum that
    // answers "has this person connected?", nothing more.
    const mayManage = await projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
    );
    if (!mayManage) {
      return c.json(
        {
          error: 'You do not have permission to view all connections',
          code: 'FORBIDDEN',
        },
        403,
      );
    }
    const rows = await db
      .select({
        connectionId: connectorConnections.connectionId,
        connectorAlias: connectors.slug,
        ownerType: connectorConnections.ownerType,
        ownerId: connectorConnections.ownerId,
        status: connectorConnections.status,
      })
      .from(connectorConnections)
      .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
      .where(eq(connectorConnections.projectId, projectId));
    return c.json({
      connections: rows.map((row) => ({
        connection_id: row.connectionId,
        connector_alias: row.connectorAlias,
        owner_type: row.ownerType,
        owner_id: row.ownerId,
        status: row.status,
      })),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connections/me',
    tags: ['connectors'],
    summary: "Create or reconcile the calling member's connection",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                connector_alias: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
                label: z.string().trim().min(1).max(255),
                metadata: ConnectionMetadataSchema.optional(),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: json(ConnectionViewSchema, 'Reconciled connection'),
      201: json(ConnectionViewSchema, 'Created connection'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (c.get('authType') === 'service_account') {
      return c.json({ error: 'Only human members can reconcile user connections' }, 403);
    }
    const body = await readJsonObject(c);
    const connectorAlias = canonicalConnectorAlias(
      typeof body.connector_alias === 'string' ? body.connector_alias.trim() : '',
    );
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    if (!connectorAlias || !label) {
      return c.json({ error: 'connector_alias and label are required' }, 400);
    }
    const [connector] = await db
      .select({
        connectorId: connectors.connectorId,
        providerType: connectors.providerType,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.projectId, projectId),
          eq(connectors.accountId, loaded.row.accountId),
          eq(connectors.slug, connectorAlias),
        ),
      )
      .limit(1);
    if (!connector) return c.json({ error: 'Connector not found' }, 404);
    if (connector.providerType === 'channel') {
      return c.json(
        { error: 'Channel connections are reconciled from verified channel installations' },
        409,
      );
    }
    // No connector-level gate: every connector can hold both a shared project
    // account and each member's own private one. Refusing here is what left a
    // former `user`-strategy connector with no connect flow at all.
    const ownerType = 'member' as const;
    const ownerId = loaded.userId;
    const { connection, created } = await reconcileConnectionRow({
      accountId: loaded.row.accountId,
      projectId,
      connectorId: connector.connectorId,
      ownerType,
      ownerId,
      label,
      metadata,
      createdBy: loaded.userId,
    });
    if (!connection) return c.json({ error: 'Connection could not be reconciled' }, 409);
    return c.json(serializeConnection({ ...connection, connectorAlias }), created ? 201 : 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/connections',
    tags: ['connectors'],
    summary: 'Create or reconcile a connection',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': { schema: ReconcileConnectionInputSchema },
        },
      },
    },
    responses: {
      200: json(ConnectionViewSchema, 'Reconciled connection'),
      201: json(ConnectionViewSchema, 'Created connection'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
    );
    const body = await readJsonObject(c);
    const requestedAlias =
      typeof body.connector_alias === 'string' ? body.connector_alias.trim() : '';
    const connectorAlias = canonicalConnectorAlias(requestedAlias);
    const ownerType = typeof body.owner_type === 'string' ? body.owner_type : 'external';
    if (ownerType === 'member' && c.get('authType') === 'service_account') {
      return c.json({ error: 'Only human members can reconcile user connections' }, 403);
    }
    // Backwards-compatible manager path: a submitted member owner is always
    // rewritten to the caller. Managers may create their own member connection,
    // but never mint one on behalf of (or later impersonate) another member.
    const ownerId =
      ownerType === 'member'
        ? loaded.userId
        : typeof body.owner_id === 'string'
          ? body.owner_id.trim()
          : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    if (
      !connectorAlias ||
      !['project', 'agent', 'member', 'subject', 'external'].includes(ownerType)
    ) {
      return c.json({ error: 'connector_alias and a valid owner_type are required' }, 400);
    }
    // A `project` (team-shared) connection belongs to the whole project and takes
    // NO owner_id — several may exist per connector, distinguished by label.
    // Creating one is already gated: this route asserts the connections-manage
    // capability above, so reaching here means the caller may administer them.
    if (ownerType === 'project') {
      if (!label) return c.json({ error: 'label is required' }, 400);
    } else if (!ownerId || !label) {
      return c.json({ error: 'owner_id and label are required' }, 400);
    }
    const [connector] = await db
      .select({
        connectorId: connectors.connectorId,
        providerType: connectors.providerType,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.projectId, projectId),
          eq(connectors.accountId, loaded.row.accountId),
          eq(connectors.slug, connectorAlias),
        ),
      )
      .limit(1);
    if (!connector) return c.json({ error: 'Connector not found' }, 404);
    if (connector.providerType === 'channel') {
      return c.json(
        { error: 'Channel connections are reconciled from verified channel installations' },
        409,
      );
    }
    const normalizedOwnerId = ownerType === 'project' ? null : ownerId;
    if (
      !connectionIsReachable({
        ownerType: ownerType as ConnectionOwnerType,
        ownerId: normalizedOwnerId,
        actingUserId: loaded.userId,
        actingPrincipalIsServiceAccount: c.get('authType') === 'service_account',
        agentPrincipal: await requestAgentPrincipalReach(c, loaded.actor),
        // Creating or reconciling an account manages it; a shared one already
        // required the manage capability above.
        audience: 'open',
      })
    ) {
      return c.json(
        {
          error: `A ${ownerType}-owned connection is not reachable by this caller`,
          code: 'CONNECTOR_CONNECTION_OWNER_NOT_REACHABLE',
        },
        409,
      );
    }
    const { connection, created } = await reconcileConnectionRow({
      accountId: loaded.row.accountId,
      projectId,
      connectorId: connector.connectorId,
      ownerType: ownerType as 'project' | 'agent' | 'member' | 'subject' | 'external',
      ownerId: normalizedOwnerId,
      label,
      metadata,
      createdBy: loaded.userId,
    });
    if (!connection) return c.json({ error: 'Connection could not be reconciled' }, 409);
    const view = serializeConnection({ ...connection, connectorAlias });
    return c.json(view, created ? 201 : 200);
  },
);

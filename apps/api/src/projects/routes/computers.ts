/** Add an already-paired computer to a project as a computer account. */
import { createRoute, z } from '@hono/zod-openapi';
import { connectors, tunnelConnections } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { attachComputerConnection } from '../../connectors/computers';
import { ensureComputerConnector } from '../../connectors/sync';
import { PROJECT_ACTIONS } from '../../iam';
import { accountRoleFor, isAccountManagerRole } from '../../iam/read-models';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { readJsonObject } from '../../shared/http-body';
import { isUuid } from '../../shared/validate';
import { requireUserCredential } from '../../tunnel/routes/auth';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';
import { parseConnectorConnectOwner } from '../lib/connection-access';
import {
  ConnectionViewSchema,
  computerConnectionFields,
  loadComputerMachines,
  serializeConnection,
} from '../lib/connection-view';

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/computers',
    tags: ['connectors'],
    summary: 'Add a paired computer to this project',
    description:
      "Makes a machine the caller already paired an account on the project's `computer` connector. " +
      '`share: "me"` (default) keeps it private to the caller; `share: "project"` shares it with the ' +
      "project and needs the connector-connections manage capability. Account managers may also share " +
      "the account's owner-less team machines. Idempotent per (connector, owner, machine). The machine " +
      "must belong to the project's account (409 otherwise).",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                tunnel_id: z.string().uuid(),
                share: z.enum(['me', 'project']).optional(),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: json(ConnectionViewSchema, 'The existing computer account'),
      201: json(ConnectionViewSchema, 'The created computer account'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    requireUserCredential(c);
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const body = await readJsonObject(c);
    const tunnelId = typeof body.tunnel_id === 'string' ? body.tunnel_id : '';
    if (!isUuid(tunnelId)) return c.json({ error: 'tunnel_id must be a UUID' }, 400);
    const share = parseConnectorConnectOwner(body.share);
    if (!share) return c.json({ error: "share must be 'me' or 'project'" }, 400);

    const userId = loaded.userId;
    const accountId = loaded.row.accountId;
    if (
      share === 'project' &&
      !(await projectCapabilityAllowed(
        c,
        userId,
        accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
      ))
    ) {
      return c.json(
        {
          error: 'Sharing a computer with the project requires permission to manage its connections',
          code: 'FORBIDDEN',
        },
        403,
      );
    }

    const [machine] = await db
      .select({
        tunnelId: tunnelConnections.tunnelId,
        accountId: tunnelConnections.accountId,
        ownerUserId: tunnelConnections.ownerUserId,
        name: tunnelConnections.name,
      })
      .from(tunnelConnections)
      .where(eq(tunnelConnections.tunnelId, tunnelId))
      .limit(1);
    // An owner-less team machine can only become a SHARED account, and only
    // through a manager of the account it belongs to.
    const reachable =
      machine &&
      (machine.ownerUserId === userId ||
        (share === 'project' &&
          machine.ownerUserId === null &&
          isAccountManagerRole(await accountRoleFor(machine.accountId, userId))));
    if (!machine || !reachable) return c.json({ error: 'Computer not found' }, 404);
    if (machine.accountId !== accountId) {
      return c.json(
        {
          error: 'This computer belongs to another account. Pair it again from this project.',
          code: 'COMPUTER_ACCOUNT_MISMATCH',
        },
        409,
      );
    }

    const connectorId = await ensureComputerConnector(projectId, accountId);
    const { connection, created } = await db.transaction((tx) =>
      attachComputerConnection(tx, {
        accountId,
        projectId,
        connectorId,
        ownerType: share === 'project' ? 'project' : 'member',
        ownerId: share === 'project' ? null : userId,
        tunnelId,
        name: machine.name,
        createdBy: userId,
      }),
    );
    const [connector] = await db
      .select({ slug: connectors.slug })
      .from(connectors)
      .where(eq(connectors.connectorId, connectorId))
      .limit(1);
    const machines = await loadComputerMachines([tunnelId]);
    return c.json(
      {
        ...serializeConnection({ ...connection, connectorAlias: connector?.slug ?? 'computer' }),
        ...computerConnectionFields({ providerType: 'computer', tunnelId: connection.tunnelId }, machines),
      },
      created ? 201 : 200,
    );
  },
);

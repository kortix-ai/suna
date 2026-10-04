/** Add an already-paired computer to a project as a computer account. */
import { createRoute, z } from '@hono/zod-openapi';
import { connectors, tunnelConnections } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { attachComputerConnection } from '../../services/connectors/computers';
import { ensureComputerConnector } from '../../services/connectors/sync';
import { PROJECT_ACTIONS } from '../../services/iam';
import { accountRoleFor, isAccountManagerRole } from '../../services/iam/read-models';
import { auth, errors, json } from '../openapi';
import { db } from '../../lib/db';
import { readJsonObject } from '../lib/http-body';
import { isUuid } from '../../lib/validate';
import { requireUserCredential } from '../tunnel/auth';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/project-access';
import { projectsApp } from './app';
import { parseConnectorConnectOwner } from '../../services/projects/lib/connection-access';
import {
  ConnectionViewSchema,
  computerConnectionFields,
  loadComputerMachines,
  serializeConnection,
} from '../../services/projects/lib/connection-view';
export function registerComputersRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/computers',
      tags: ['connectors'],
      summary: 'Add a paired computer to this project',
      description:
        "Makes a machine the caller already paired an account on the project's `computer` connector. " +
        '`share: "project"` shares it with the project and needs the connector-connections manage ' +
        'capability. `share: "me"` (default) creates the private account every project already gets ' +
        "automatically when its owner opens it. Account managers may also share " +
        "the account's owner-less team machines. Idempotent per (connector, owner, machine). A shared " +
        "account or a team machine must belong to the project's account (409 otherwise). Agent session " +
        'tokens get 403.',
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
      // Refuses session and agent tokens: attaching a machine is its owner's act.
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
      // The owner's own machine joins any project they can read as a private
      // account: relay auth keys on the machine's account, not the project's.
      // Team machines stay inside the machine's account. A private machine lives
      // in its owner's personal account (id = user id); its owner may share it
      // with any project they manage. The machine stays where it is: the relay
      // binds a connected agent to the account it authenticated under.
      const personal = machine.ownerUserId === userId && machine.accountId === userId;
      if (machine.accountId !== accountId && !personal && (share === 'project' || machine.ownerUserId !== userId)) {
        return c.json(
          {
            error: 'This computer belongs to another account. Pair it again from this project.',
            code: 'COMPUTER_ACCOUNT_MISMATCH',
          },
          409,
        );
      }

      const connectorId = await ensureComputerConnector(projectId, accountId);
      const attached = await db.transaction((tx) =>
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
      // Unpaired between the lookup above and the attach.
      if (!attached) return c.json({ error: 'Computer not found' }, 404);
      const { connection, created } = attached;
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
}

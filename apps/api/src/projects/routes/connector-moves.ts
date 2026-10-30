/** Move a Pipedream or Composio connector to its Kortix MCP app. The service: connectors/connector-move.ts. */
import { createRoute, z } from '@hono/zod-openapi';
import { listConnectorMoves, moveConnector } from '../../connectors/connector-move';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json, lenientBody } from '../../openapi';
import { readJsonObject } from '../../shared/http-body';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';
import { loadMutableConnection } from '../lib/connection-mutation';

const ConnectorMoveSchema = z.object({
  slug: z.string(),
  name: z.string(),
  provider: z.enum(['pipedream', 'composio']).openapi({ description: 'The retired provider the connector runs on.' }),
  app: z.string().nullable().openapi({ description: "The connector's app on that provider." }),
  to: z
    .object({ slug: z.string(), name: z.string(), icon: z.string().nullable() })
    .nullable()
    .openapi({ description: 'The Kortix app it moves to. Null: no Kortix connection for this app on this deployment yet.' }),
  connection_id: z.string().nullable().openapi({ description: 'The account a started move signs in on.' }),
  signed_in: z.boolean().openapi({ description: 'The move signed in; only the switch is left.' }),
  accounts: z.number().int().openapi({ description: 'Accounts on the connector. All but the moved one sign in again.' }),
});

const MoveInputSchema = z.object({
  connection_id: z.string().optional().openapi({ description: "The account to sign in on. Default: the project's account." }),
});

const MoveResultSchema = z.object({
  status: z.enum(['sign_in', 'moved']).openapi({
    description: '`sign_in`: sign in on `connection_id` with the OAuth routes; the connector switches when it completes. `moved`: the connector now uses `provider: mcp`.',
  }),
  connection_id: z.string().optional(),
  to: z.object({ slug: z.string(), name: z.string(), url: z.string() }).optional(),
});

export function registerConnectorMoveRoutes(): void {
  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'get',
      path: '/{projectId}/connector-moves',
      summary: 'List Pipedream and Composio connectors and the Kortix app each moves to',
      request: { params: z.object({ projectId: z.string() }) },
      responses: {
        200: json(z.object({ moves: z.array(ConnectorMoveSchema) }), 'Pipedream and Composio connectors'),
        ...errors(403, 404),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      return c.json({ moves: await listConnectorMoves(projectId) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      tags: ['connectors'],
      ...auth,
      method: 'post',
      path: '/{projectId}/connectors/{slug}/move',
      summary: 'Move a Pipedream or Composio connector to its Kortix app',
      description:
        'Starts a move: marks an account and returns it with `status: sign_in`. Sign in on that account with the OAuth2 routes; the connector switches to `provider: mcp` when the sign-in completes, and keeps its slug. Calling again after the sign-in finishes a move whose switch failed.',
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody(MoveInputSchema.shape) } } },
      },
      responses: {
        200: json(MoveResultSchema, 'The next step'),
        ...errors(400, 403, 404, 409, 502),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const mayWrite = await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
      );
      if (!mayWrite) return c.json({ error: 'Forbidden' }, 403);
      const parsed = MoveInputSchema.safeParse(await readJsonObject(c));
      if (!parsed.success) return c.json({ error: 'connection_id must be a string' }, 400);
      // The caller signs in on the marked account next, so they must be able to:
      // a named account they may change (404 otherwise, so accounts cannot be
      // probed), or the project's own account as a connections manager.
      if (parsed.data.connection_id) {
        if (!(await loadMutableConnection(c, projectId, parsed.data.connection_id))) {
          return c.json({ error: 'Connection not found' }, 404);
        }
      } else if (
        !(await projectCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
        ))
      ) {
        return c.json({ error: "Only a connections manager can move the project's account" }, 403);
      }
      const result = await moveConnector({
        projectId,
        slug: c.req.param('slug'),
        userId: loaded.userId,
        connectionId: parsed.data.connection_id,
      });
      if (!result.ok) return c.json({ error: result.error }, result.status);
      const { ok: _ok, ...body } = result;
      return c.json(body, 200);
    },
  );
}

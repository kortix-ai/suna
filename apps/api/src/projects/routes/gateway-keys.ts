import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  createGatewayKey,
  listGatewayKeys,
  revokeGatewayKey,
} from '../../llm-gateway/gateway-keys';
import { publicGatewayBaseUrl } from '../../llm-gateway/public-url';
import { config } from '../../config';

export function registerGatewayKeysRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/gateway/keys',
      tags: ['gateway'],
      summary: 'List project LLM gateway API keys',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(z.any(), 'Gateway API keys'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      if (!(await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE,
      ))) {
        return c.json({ error: 'You do not have permission to manage gateway keys' }, 403);
      }
      const keys = await listGatewayKeys(projectId);
      return c.json({
        // Env-correct public host (dev vs prod) so the UI's curl example points at
        // the right gateway instead of a hardcoded one.
        gateway_url: publicGatewayBaseUrl(config.LLM_GATEWAY_BASE_URL),
        keys: keys.map((k) => ({
          key_id: k.keyId,
          name: k.name,
          key_prefix: k.keyPrefix,
          status: k.status,
          last_used_at: k.lastUsedAt,
          created_at: k.createdAt,
        })),
      });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/gateway/keys',
      tags: ['gateway'],
      summary: 'Create a project LLM gateway API key',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: {
          content: {
            'application/json': { schema: z.object({ name: z.string().min(1).max(255) }) },
          },
        },
      },
      responses: { 200: json(z.any(), 'Gateway API key created'), ...errors(400, 403, 404) },
    }),
    async (c: any) => {
      // A connected app's revocable `kortix_oat_` token must not mint a durable one.
      if (c.get('authType') === 'oauth') return c.json({ error: 'Connected apps cannot mint gateway keys.' }, 403);
      const projectId = c.req.param('projectId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      if (!(await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE,
      ))) {
        return c.json({ error: 'You do not have permission to manage gateway keys' }, 403);
      }
      const body = await c.req.json();
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return c.json({ error: 'A key name is required' }, 400);
      const created = await createGatewayKey({
        accountId: loaded.row.accountId,
        projectId,
        name,
        createdBy: c.get('userId'),
      });
      return c.json(created);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/gateway/keys/{keyId}',
      tags: ['gateway'],
      summary: 'Revoke a project LLM gateway API key',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), keyId: z.string().uuid() }),
      },
      responses: { 200: json(z.any(), 'Gateway API key revoked'), ...errors(403, 404) },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const keyId = c.req.param('keyId');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      if (!(await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE,
      ))) {
        return c.json({ error: 'You do not have permission to manage gateway keys' }, 403);
      }
      const ok = await revokeGatewayKey(projectId, keyId);
      return c.json({ ok });
    },
  );
}

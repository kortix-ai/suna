import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { projectsApp } from '../lib/app';
import { loadProjectForUser } from '../lib/access';
import { bindUserProviderConnection, listProjectUserProviderConnections } from '../../provider-connections/store';
import { recordAuditEvent } from '../../shared/audit';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';

const responses = { 200: json(z.any(), 'Personal provider bindings'), ...errors(400, 401, 403, 404, 409) };
projectsApp.openapi(createRoute({ method: 'get', path: '/{projectId}/personal-providers', tags: ['providers'], ...auth,
  request: { params: z.object({ projectId: z.string().uuid() }) }, responses }), async (c) => {
  if (c.get('authType') !== 'supabase' || c.get('impersonationGrantId')) return c.json({ error: 'Sign in to manage personal provider connections' }, 403);
  const loaded = await loadProjectForUser(c, c.req.valid('param').projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  return c.json({ items: await listProjectUserProviderConnections(loaded.row.projectId, loaded.userId) });
});

projectsApp.openapi(createRoute({ method: 'put', path: '/{projectId}/personal-providers/{provider}', tags: ['providers'], ...auth,
  request: { params: z.object({ projectId: z.string().uuid(), provider: z.string().min(1).max(128) }),
    body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }).strict() } } } }, responses }), async (c) => {
  if (c.get('authType') !== 'supabase' || c.get('impersonationGrantId')) return c.json({ error: 'Sign in to manage personal provider connections' }, 403);
  const { projectId, provider } = c.req.valid('param');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const { enabled } = c.req.valid('json');
  if (enabled && !projectLlmGatewayEnabled(loaded.row.metadata)) return c.json({ error: 'Personal providers require the LLM gateway for this project' }, 409);
  if (!await bindUserProviderConnection(projectId, loaded.userId, provider, enabled)) return c.json({ error: 'Connect this provider in your personal connections first' }, 404);
  await recordAuditEvent({ accountId: loaded.row.accountId, projectId, actorUserId: loaded.userId,
    actorType: 'human', source: 'api', action: enabled ? 'provider.personal.enabled' : 'provider.personal.disabled',
    resourceType: 'provider_connection', metadata: { provider_id: provider } });
  void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: true });
  return c.json({ ok: true });
});

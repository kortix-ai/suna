import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import {
  resolveProjectComposerState,
  writeHarnessAuthRoute,
  type HarnessAuthKind,
  type HarnessId,
} from '../lib/composer-capabilities';
import { withProjectGitAuth } from '../lib/git';
import { readBody } from '../lib/serializers';
import { projectsApp } from '../lib/app';

const HarnessSchema = z.enum(['claude', 'codex', 'opencode', 'pi']);
const ConnectionSchema = z.enum([
  'managed_gateway',
  'claude_subscription',
  'anthropic_api_key',
  'codex_subscription',
  'openai_api_key',
  'openai_compatible',
  'anthropic_compatible',
  'native_config',
]);

async function loadState(c: any, projectId: string) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return null;
  const project = await withProjectGitAuth(loaded.row);
  const state = await resolveProjectComposerState({
    project,
    userId: loaded.userId,
    metadata: loaded.row.metadata,
  });
  return { loaded, project, state };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/harness-connections',
    tags: ['projects'],
    summary: 'List harness authentication connections and active bindings',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.any(), 'Harness connections'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const loaded = await loadState(c, c.req.param('projectId'));
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    return c.json({ connections: loaded.state.connections, providers: loaded.state.providers });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/composer-capabilities',
    tags: ['projects'],
    summary: 'Resolve agent, authentication, and model capabilities for session creation',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ agent_name: z.string(), connection_id: ConnectionSchema.optional() }),
    },
    responses: { 200: json(z.any(), 'Composer capabilities'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const loaded = await loadState(c, c.req.param('projectId'));
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    try {
      return c.json(await loaded.state.capabilities(
        c.req.query('agent_name'),
        (c.req.query('connection_id') as HarnessAuthKind | undefined) ?? null,
      ));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/model-catalog',
    tags: ['projects'],
    summary: 'List authoritative models for one agent and authentication route',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ agent_name: z.string(), connection_id: ConnectionSchema.optional() }),
    },
    responses: { 200: json(z.any(), 'Harness-qualified model catalog'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const loaded = await loadState(c, c.req.param('projectId'));
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    try {
      const capability = await loaded.state.capabilities(
        c.req.query('agent_name'),
        (c.req.query('connection_id') as HarnessAuthKind | undefined) ?? null,
      );
      return c.json({
        agent: capability.agent,
        connection_id: capability.auth.active,
        policy: capability.model.policy,
        default_allowed: capability.model.default_allowed,
        custom_allowed: capability.model.custom_allowed,
        models: capability.model.presets,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/harness-connections/{harness}/active',
    tags: ['projects'],
    summary: 'Select the explicit authentication route for a harness',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), harness: HarnessSchema }),
      body: { content: { 'application/json': { schema: z.object({ connection_id: ConnectionSchema.nullable() }) } } },
    },
    responses: { 200: json(z.any(), 'Updated harness binding'), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadState(c, projectId);
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.loaded.userId,
      loaded.loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
    );
    const body = await readBody(c);
    const harness = c.req.param('harness') as HarnessId;
    const connectionId = (body.connection_id ?? null) as HarnessAuthKind | null;
    if (connectionId) {
      const selected = loaded.state.connections.find((connection) => connection.id === connectionId);
      if (!selected?.compatible_harnesses.includes(harness)) {
        return c.json({ error: `${connectionId} is not compatible with ${harness}` }, 400);
      }
      if (!selected.ready) return c.json({ error: selected.reason ?? 'Connection is not ready' }, 409);
    }
    const metadata = writeHarnessAuthRoute(loaded.loaded.row.metadata, harness, connectionId);
    await db.update(projects).set({ metadata, updatedAt: new Date() }).where(eq(projects.projectId, projectId));
    const state = await resolveProjectComposerState({
      project: loaded.project,
      userId: loaded.loaded.userId,
      metadata,
    });
    return c.json({ connections: state.connections, providers: state.providers });
  },
);

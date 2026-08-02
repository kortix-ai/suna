/**
 * Unified Agent Capability Profile route boundaries.
 *
 * Stateful publication and retrieval behavior runs in the API integration
 * suite. These black-box checks keep every deployed route mounted and protected.
 */
import { flow } from '../core/flow';

const PROJECT_ID = '00000000-0000-4000-a000-000000000001';
const SESSION_ID = '00000000-0000-4000-a000-000000000002';
const SOURCE_ID = '00000000-0000-4000-a000-000000000003';
const AGENT_NAME = 'support';

flow(
  'APROF-1',
  {
    domain: 'agent-profile',
    routes: [
      'GET /v1/projects/:projectId/agents/:agentName/profile',
      'PUT /v1/projects/:projectId/agents/:agentName/profile/draft',
      'POST /v1/projects/:projectId/agents/:agentName/profile/preview',
      'POST /v1/projects/:projectId/agents/:agentName/profile/test',
      'POST /v1/projects/:projectId/agents/:agentName/profile/publish',
      'POST /v1/projects/:projectId/agents/:agentName/profile/discard',
      'POST /v1/projects/:projectId/agents/:agentName/profile/automations/:automationSlug/pause',
      'POST /v1/projects/:projectId/agents/:agentName/profile/skills/generate',
      'POST /v1/projects/:projectId/agents/:agentName/profile/skills/github',
      'POST /v1/projects/:projectId/agents/:agentName/profile/skills/import',
      'POST /v1/projects/:projectId/agents/:agentName/profile/skills/marketplace',
    ],
  },
  async (ctx) => {
    const anon = ctx.client.as(ctx.P.ANON);
    const params = { projectId: PROJECT_ID, agentName: AGENT_NAME };

    await ctx.step('profile reads and shared-draft updates require authentication', async () => {
      const read = await anon.get('/v1/projects/:projectId/agents/:agentName/profile', { params });
      read.status(401);
      const update = await anon.put(
        '/v1/projects/:projectId/agents/:agentName/profile/draft',
        { expectedRevision: 0, sections: {} },
        { params },
      );
      update.status(401);
    });

    await ctx.step('profile lifecycle actions require authentication', async () => {
      for (const route of [
        '/v1/projects/:projectId/agents/:agentName/profile/preview',
        '/v1/projects/:projectId/agents/:agentName/profile/test',
        '/v1/projects/:projectId/agents/:agentName/profile/publish',
        '/v1/projects/:projectId/agents/:agentName/profile/discard',
      ]) {
        const response = await anon.post(route, { expectedRevision: 0 }, { params });
        response.status(401);
      }
    });

    await ctx.step('pause and skill staging require authentication', async () => {
      const pause = await anon.post(
        '/v1/projects/:projectId/agents/:agentName/profile/automations/:automationSlug/pause',
        {},
        { params: { ...params, automationSlug: 'weekday-briefing' } },
      );
      pause.status(401);

      for (const route of [
        '/v1/projects/:projectId/agents/:agentName/profile/skills/generate',
        '/v1/projects/:projectId/agents/:agentName/profile/skills/github',
        '/v1/projects/:projectId/agents/:agentName/profile/skills/import',
        '/v1/projects/:projectId/agents/:agentName/profile/skills/marketplace',
      ]) {
        const response = await anon.post(route, {}, { params });
        response.status(401);
      }
    });
  },
);

flow(
  'KNOW-1',
  {
    domain: 'agent-profile',
    routes: [
      'GET /v1/projects/:projectId/agents/:agentName/knowledge',
      'POST /v1/projects/:projectId/agents/:agentName/knowledge/sources',
      'POST /v1/projects/:projectId/agents/:agentName/knowledge/uploads',
      'POST /v1/projects/:projectId/agents/:agentName/knowledge/:sourceId/complete',
      'POST /v1/projects/:projectId/agents/:agentName/knowledge/:sourceId/sync',
      'DELETE /v1/projects/:projectId/agents/:agentName/knowledge/:sourceId',
      'POST /v1/projects/:projectId/sessions/:sessionId/knowledge/search',
      'GET /v1/projects/:projectId/sessions/:sessionId/knowledge/:citationId',
    ],
  },
  async (ctx) => {
    const anon = ctx.client.as(ctx.P.ANON);
    const agentParams = { projectId: PROJECT_ID, agentName: AGENT_NAME };
    const sourceParams = { ...agentParams, sourceId: SOURCE_ID };

    await ctx.step('knowledge source management requires authentication', async () => {
      const list = await anon.get('/v1/projects/:projectId/agents/:agentName/knowledge', {
        params: agentParams,
      });
      list.status(401);

      for (const route of [
        '/v1/projects/:projectId/agents/:agentName/knowledge/sources',
        '/v1/projects/:projectId/agents/:agentName/knowledge/uploads',
      ]) {
        const response = await anon.post(route, {}, { params: agentParams });
        response.status(401);
      }

      for (const route of [
        '/v1/projects/:projectId/agents/:agentName/knowledge/:sourceId/complete',
        '/v1/projects/:projectId/agents/:agentName/knowledge/:sourceId/sync',
      ]) {
        const response = await anon.post(route, {}, { params: sourceParams });
        response.status(401);
      }

      const revoke = await anon.del(
        '/v1/projects/:projectId/agents/:agentName/knowledge/:sourceId',
        { params: sourceParams },
      );
      revoke.status(401);
    });

    await ctx.step('session retrieval requires an authenticated session identity', async () => {
      const sessionParams = { projectId: PROJECT_ID, sessionId: SESSION_ID };
      const search = await anon.post(
        '/v1/projects/:projectId/sessions/:sessionId/knowledge/search',
        { query: 'private source' },
        { params: sessionParams },
      );
      search.status(401);
      const read = await anon.get(
        '/v1/projects/:projectId/sessions/:sessionId/knowledge/:citationId',
        { params: { ...sessionParams, citationId: 'citation-1' } },
      );
      read.status(401);
    });
  },
);

/**
 * A member's Claude subscription login (spec §15 SEC-CLAUDE-1): stored for
 * that member only, in every project of the account, and never returned.
 */
import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';

// Synthetic: the shape `claude setup-token` prints, not a real token.
const TOKEN = `sk-ant-oat01-${'e2eSyntheticClaudeToken_'.repeat(3)}0123456789`;

flow(
  'SEC-CLAUDE-1',
  {
    domain: 'secrets',
    routes: [
      'GET /v1/projects/:projectId/claude-subscription',
      'PUT /v1/projects/:projectId/claude-subscription/token',
      'POST /v1/projects/:projectId/claude-subscription/login/start',
      'POST /v1/projects/:projectId/claude-subscription/login/complete',
      'DELETE /v1/projects/:projectId/claude-subscription',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const other = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const path = '/v1/projects/:projectId/claude-subscription';
    const params = { projectId: project.id };
    const leaks = (text: string) => text.includes(TOKEN) || text.includes('sk-ant-oat01-');

    await ctx.step('a member with no login reads connected: false', async () => {
      (await owner.get(path, { params })).status(200).body()
        .has('$.connected', false).has('$.source', null).has('$.connected_at', null).has('$.usable', false);
    });

    await ctx.step('a malformed token → 400 invalid_token, nothing stored', async () => {
      (await owner.put(`${path}/token`, { token: 'not-a-claude-token' }, { params })).status(400).body().has('$.code', 'invalid_token');
      (await owner.put(`${path}/token`, { token: 'sk-ant-api03-wrongkindofkey0123456789abcdef' }, { params })).status(400);
      (await owner.get(path, { params })).status(200).body().has('$.connected', false);
    });

    await ctx.step('the owner pastes a token → connected, source pasted, the value never in the answer', async () => {
      const stored = await owner.put(`${path}/token`, { token: TOKEN }, { params });
      stored.status(200).body().has('$.connected', true).has('$.source', 'pasted').has('$.usable', true).exists('$.connected_at');
      if (leaks(stored.text())) throw new Error('the token is in the PUT answer');
    });

    await ctx.step('the same login reads connected in another project of the account', async () => {
      const read = await owner.get(path, { params: { projectId: other.id } });
      read.status(200).body().has('$.connected', true).has('$.source', 'pasted');
      if (leaks(read.text())) throw new Error('the token is in the status answer');
    });

    await ctx.step('no secret listing carries the token', async () => {
      const secrets = await owner.get('/v1/projects/:projectId/secrets', { params });
      secrets.status(200);
      if (leaks(secrets.text())) throw new Error('the token is in the project secret list');
      const resources = await owner.get('/v1/accounts/:accountId/secret-resources', { params: { accountId: team.id } });
      resources.status(200);
      if (leaks(resources.text())) throw new Error('the token is in the account secret resources');
    });

    await ctx.step('another member sees only their own state and cannot remove the owner login', async () => {
      (await asMember.get(path, { params })).status(200).body().has('$.connected', false);
      (await asMember.del(path, { params })).status(200).body().has('$.connected', false);
      (await owner.get(path, { params })).status(200).body().has('$.connected', true);
    });

    await ctx.step('a non-member is refused', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).get(path, { params })).status([403, 404]);
      (await ctx.client.as(ctx.P.NONMEMBER).put(`${path}/token`, { token: TOKEN }, { params })).status([403, 404]);
    });

    await ctx.step('complete with an unknown flow → 404; with no code → 400', async () => {
      (await owner.post(`${path}/login/complete`, { flow_id: '00000000-0000-4000-8000-0000000000aa', code: 'abc' }, { params }))
        .status(404).body().has('$.code', 'not_found');
      (await owner.post(`${path}/login/complete`, { flow_id: '00000000-0000-4000-8000-0000000000aa' }, { params })).status(400);
    });

    await ctx.step('start runs claude setup-token → a claude.com sign-in link, or 503 where Claude Code is not installed', async () => {
      const started = await owner.post(`${path}/login/start`, {}, { params });
      if (started.statusCode === 503) {
        started.body().has('$.code', 'claude_unavailable');
        return;
      }
      started.status(200).body().exists('$.flow_id').exists('$.expires_at');
      const url = new URL(started.json<{ authorize_url: string }>().authorize_url);
      if (!/^(claude\.com|claude\.ai)$/.test(url.host) || !url.pathname.endsWith('/oauth/authorize')) {
        throw new Error(`unexpected sign-in link host/path: ${url.host}${url.pathname}`);
      }
    });

    await ctx.step('disconnect → connected: false here and in the other project', async () => {
      (await owner.del(path, { params })).status(200).body().has('$.connected', false);
      (await owner.get(path, { params: { projectId: other.id } })).status(200).body().has('$.connected', false);
    });
  },
);

flow(
  'SEC-CLAUDE-2',
  {
    domain: 'secrets',
    routes: [
      'GET /v1/projects/:projectId/model-picker',
      'PUT /v1/projects/:projectId/model-defaults',
      'POST /v1/projects/:projectId/sessions',
      'PUT /v1/projects/:projectId/sessions/:sessionId/model',
      'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
      'PUT /v1/projects/:projectId/claude-subscription/token',
      'DELETE /v1/projects/:projectId/claude-subscription',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ seed: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id };
    const VALID = 'claude-agent/opus, claude-agent/fable, claude-agent/sonnet, claude-agent/haiku';
    const session = await createDatabaseSession(ctx.env, {
      projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId!, visibility: 'private',
    });
    const sessionParams = { projectId: project.id, sessionId: session };
    const prompt = (model: { providerID: string; modelID: string }, id: string) =>
      owner.post('/v1/projects/:projectId/sessions/:sessionId/prompts', {
        client_message_id: id, parts: [{ type: 'text', text: 'hello' }], overrides: { model },
      }, { params: sessionParams });

    await ctx.step('the picker lists the Claude subscription group apart from the gateway models, not connected', async () => {
      const picker = await owner.get('/v1/projects/:projectId/model-picker', { params });
      picker.status(200).body().has('$.claudeSubscription.providerId', 'claude-agent').has('$.claudeSubscription.connected', false);
      const body = picker.json<any>();
      const ids = (body.claudeSubscription.models as any[]).map((model) => model.id);
      if (ids.join(', ') !== VALID) throw new Error(`picker group ids: ${ids.join(', ')}`);
      if ((body.claudeSubscription.models as any[]).some((model) => model.requires !== 'claude_subscription' || model.connected !== false)) {
        throw new Error('a picker entry is not marked requires: claude_subscription, connected: false');
      }
      if (Object.keys(body.models ?? {}).some((id) => id.startsWith('claude-agent/'))) throw new Error('a Claude subscription model is in the gateway list');
    });

    await ctx.step('a project default on a known Claude model → 200; an unknown id → 400 naming the valid ids', async () => {
      (await owner.put('/v1/projects/:projectId/model-defaults', { scope: 'project', model: 'claude-agent/sonnet' }, { params })).status(200);
      const refused = await owner.put('/v1/projects/:projectId/model-defaults', { scope: 'project', model: 'claude-agent/gpt-9' }, { params });
      refused.status(400).body().has('$.code', 'invalid_model');
      if (!refused.text().includes(VALID)) throw new Error(`the refusal does not list the valid ids: ${refused.text()}`);
    });

    await ctx.step('session create: an unknown Claude id → 400 INVALID_SESSION_MODEL; a first prompt without a login → 409 claude_subscription_required', async () => {
      const unknown = await owner.post('/v1/projects/:projectId/sessions', { model: 'claude-agent/gpt-9' }, { params });
      unknown.status(400).body().has('$.code', 'INVALID_SESSION_MODEL');
      if (!unknown.text().includes(VALID)) throw new Error('the create refusal does not list the valid ids');
      (await owner.post('/v1/projects/:projectId/sessions', { model: 'claude-agent/opus', initial_prompt: 'hello' }, { params }))
        .status(409).body().has('$.code', 'claude_subscription_required').has('$.model', 'claude-agent/opus');
    });

    await ctx.step('session model change: a known Claude id is stored as-is; an unknown one → 400', async () => {
      const changed = await owner.put('/v1/projects/:projectId/sessions/:sessionId/model', { model: 'claude-agent/haiku' }, { params: sessionParams });
      if (changed.statusCode !== 200 && changed.statusCode !== 202) throw new Error(`model change returned ${changed.statusCode}: ${changed.text()}`);
      if (!changed.text().includes('claude-agent/haiku') || changed.text().includes('kortix/claude-agent')) {
        throw new Error(`the stored model is not claude-agent/haiku as-is: ${changed.text()}`);
      }
      const refused = await owner.put('/v1/projects/:projectId/sessions/:sessionId/model', { model: 'claude-agent/gpt-9' }, { params: sessionParams });
      refused.status(400).body().has('$.code', 'INVALID_SESSION_MODEL');
    });

    await ctx.step('a prompt on a Claude model without a login → 409 claude_subscription_required, nothing queued', async () => {
      const refused = await prompt({ providerID: 'claude-agent', modelID: 'opus' }, 'claude-gate-1');
      refused.status(409).body()
        .has('$.code', 'claude_subscription_required')
        .has('$.message', 'Connect your Claude subscription to use Claude models.')
        .has('$.provider_id', 'claude-agent');
    });

    await ctx.step('after the login the picker reads connected and the prompt passes the Claude gate', async () => {
      (await owner.put('/v1/projects/:projectId/claude-subscription/token', { token: TOKEN }, { params })).status(200);
      (await owner.get('/v1/projects/:projectId/model-picker', { params })).status(200).body()
        .has('$.claudeSubscription.connected', true).has('$.claudeSubscription.models[0].connected', true);
      const passed = await prompt({ providerID: 'claude-agent', modelID: 'opus' }, 'claude-gate-2');
      if (passed.statusCode === 409 && passed.text().includes('claude_subscription_required')) throw new Error('the gate refused a connected person');
      (await owner.del('/v1/projects/:projectId/claude-subscription', { params })).status(200);
    });
  },
);

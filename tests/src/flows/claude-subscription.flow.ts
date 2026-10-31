/**
 * Claude accounts (spec §15 SEC-CLAUDE-1, SEC-CLAUDE-2): a member's Claude Pro
 * or Max login is a named provider account of the project, like a ChatGPT
 * account: private to its creator until shared, never returned, and used only
 * by the LLM gateway for Claude Code's model calls.
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
      'GET /v1/accounts/:accountId/secret-resources',
      'PUT /v1/accounts/:accountId/secret-resources/:secretId/access',
      'PUT /v1/accounts/:accountId/secret-resources/:secretId/value',
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
    let secretId = '';

    await ctx.step('a member with no Claude account reads connected: false, accounts: 0', async () => {
      (await owner.get(path, { params })).status(200).body().has('$.connected', false).has('$.accounts', 0);
    });

    await ctx.step('a malformed token → 400 invalid_token, nothing stored', async () => {
      (await owner.put(`${path}/token`, { token: 'not-a-claude-token' }, { params })).status(400).body().has('$.code', 'invalid_token');
      (await owner.put(`${path}/token`, { token: 'sk-ant-api03-wrongkindofkey0123456789abcdef' }, { params })).status(400);
      (await owner.get(path, { params })).status(200).body().has('$.connected', false);
    });

    await ctx.step('the owner pastes a token → a Claude account private to them, the value never in the answer', async () => {
      const stored = await owner.put(`${path}/token`, { token: TOKEN }, { params });
      stored.status(200).body().has('$.connected', true).exists('$.secret_id');
      if (leaks(stored.text())) throw new Error('the token is in the PUT answer');
      secretId = stored.json<{ secret_id: string }>().secret_id;
      (await owner.get(path, { params })).status(200).body().has('$.connected', true).has('$.accounts', 1);
    });

    await ctx.step('the account list shows it as a private Claude account, without the token', async () => {
      const listed = await owner.get('/v1/accounts/:accountId/secret-resources', { params: { accountId: team.id }, query: { project_id: project.id } });
      listed.status(200);
      if (leaks(listed.text())) throw new Error('the token is in the account list');
      const row = listed.json<{ secrets: any[] }>().secrets.find((entry) => entry.secret_id === secretId);
      if (!row) throw new Error('the Claude account is not in the account list');
      if (row.provider_id !== 'claude-agent' || row.label !== 'Claude' || row.access_mode !== 'members' || row.project_id !== project.id) {
        throw new Error(`unexpected Claude account row: ${JSON.stringify({ ...row, granted_user_ids: undefined })}`);
      }
      const secrets = await owner.get('/v1/projects/:projectId/secrets', { params });
      secrets.status(200);
      if (leaks(secrets.text())) throw new Error('the token is in the project secret list');
    });

    await ctx.step('the account belongs to this project only, and another member cannot use it until it is shared', async () => {
      (await owner.get(path, { params: { projectId: other.id } })).status(200).body().has('$.connected', false);
      (await asMember.get(path, { params })).status(200).body().has('$.connected', false).has('$.accounts', 0);
      (await owner.put('/v1/accounts/:accountId/secret-resources/:secretId/access', { mode: 'project', user_ids: [] }, { params: { accountId: team.id, secretId } }))
        .status(200).body().has('$.access_mode', 'project');
      (await asMember.get(path, { params })).status(200).body().has('$.connected', true).has('$.accounts', 1);
    });

    await ctx.step('a Claude login is reconnected, never rotated; only its creator reconnects it', async () => {
      (await owner.put('/v1/accounts/:accountId/secret-resources/:secretId/value', { value: TOKEN }, { params: { accountId: team.id, secretId } })).status(400);
      (await asMember.put(`${path}/token`, { token: TOKEN, resource_id: secretId }, { params })).status(403);
      (await owner.put(`${path}/token`, { token: TOKEN, resource_id: secretId }, { params })).status(200).body().has('$.secret_id', secretId);
    });

    await ctx.step('another member\'s DELETE removes only their own accounts', async () => {
      (await asMember.del(path, { params })).status(200).body().has('$.connected', true);
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
      (await owner.post(`${path}/login/start`, { resource_label: '' }, { params })).status(400);
      const started = await owner.post(`${path}/login/start`, { resource_label: 'Work plan', sharing: { mode: 'private' } }, { params });
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

    await ctx.step('the owner deletes their Claude accounts → nobody is connected', async () => {
      (await owner.del(path, { params })).status(200).body().has('$.connected', false);
      (await asMember.get(path, { params })).status(200).body().has('$.connected', false);
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
      'PUT /v1/projects/:projectId/model-access',
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
      if ((body.claudeSubscription.models as any[]).some((model) => model.requires !== 'claude_subscription' || model.connected !== false || model.enabled !== true)) {
        throw new Error('a picker entry is not marked requires: claude_subscription, connected: false, enabled: true');
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

    await ctx.step('a model turned off in the model settings reads enabled: false and a session cannot switch to it', async () => {
      (await owner.put('/v1/projects/:projectId/model-access', { target: 'model', id: 'claude-agent/fable', enabled: false }, { params })).status(200);
      const models = (await owner.get('/v1/projects/:projectId/model-picker', { params })).json<any>().claudeSubscription.models as any[];
      const enabled = Object.fromEntries(models.map((model) => [model.id, model.enabled]));
      if (enabled['claude-agent/fable'] !== false || enabled['claude-agent/opus'] !== true) throw new Error(`enabled after turning fable off: ${JSON.stringify(enabled)}`);
      const switched = await owner.put('/v1/projects/:projectId/sessions/:sessionId/model', { model: 'claude-agent/fable' }, { params: sessionParams });
      if (switched.statusCode < 400) throw new Error(`a session switched to a turned-off model: ${switched.statusCode}`);
      (await owner.put('/v1/projects/:projectId/model-access', { target: 'model', id: 'claude-agent/fable', enabled: true }, { params })).status(200);
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

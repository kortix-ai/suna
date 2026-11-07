/**
 * Claude accounts (spec §15 SEC-CLAUDE-1, SEC-CLAUDE-2): a member's Claude Pro
 * or Max login is a named provider account of the project, like a ChatGPT
 * account: private to its creator until shared, never returned, and used only
 * by the LLM gateway for Claude Code's model calls.
 */
import { Client } from '../core/client';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import { createDatabaseSession } from '../fixtures/database-project';

// Synthetic: the shape `claude setup-token` prints, not a real token.
const TOKEN = `sk-ant-oat01-${'e2eSyntheticClaudeToken_'.repeat(3)}0123456789`;

flow(
  'SEC-CLAUDE-1',
  {
    domain: 'secrets',
    routes: [
      'GET /v1/workspaces/:projectId/claude-subscription',
      'PUT /v1/workspaces/:projectId/claude-subscription/token',
      'POST /v1/workspaces/:projectId/claude-subscription/login/start',
      'POST /v1/workspaces/:projectId/claude-subscription/login/complete',
      'DELETE /v1/workspaces/:projectId/claude-subscription',
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
    const path = '/v1/workspaces/:projectId/claude-subscription';
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
      const secrets = await owner.get('/v1/workspaces/:projectId/secrets', { params });
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
      'GET /v1/workspaces/:projectId/model-picker',
      'PUT /v1/workspaces/:projectId/model-defaults',
      'POST /v1/workspaces/:projectId/sessions',
      'PUT /v1/workspaces/:projectId/sessions/:sessionId/model',
      'POST /v1/workspaces/:projectId/sessions/:sessionId/prompts',
      'PUT /v1/workspaces/:projectId/claude-subscription/token',
      'DELETE /v1/workspaces/:projectId/claude-subscription',
      'PUT /v1/workspaces/:projectId/model-access',
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
      owner.post('/v1/workspaces/:projectId/sessions/:sessionId/prompts', {
        client_message_id: id, parts: [{ type: 'text', text: 'hello' }], overrides: { model },
      }, { params: sessionParams });

    await ctx.step('the picker lists the Claude subscription group apart from the gateway models, not connected', async () => {
      const picker = await owner.get('/v1/workspaces/:projectId/model-picker', { params });
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
      (await owner.put('/v1/workspaces/:projectId/model-defaults', { scope: 'project', model: 'claude-agent/sonnet' }, { params })).status(200);
      const refused = await owner.put('/v1/workspaces/:projectId/model-defaults', { scope: 'project', model: 'claude-agent/gpt-9' }, { params });
      refused.status(400).body().has('$.code', 'invalid_model');
      if (!refused.text().includes(VALID)) throw new Error(`the refusal does not list the valid ids: ${refused.text()}`);
    });

    await ctx.step('session create: an unknown Claude id → 400 INVALID_SESSION_MODEL; a first prompt without a login → 409 claude_subscription_required', async () => {
      const unknown = await owner.post('/v1/workspaces/:projectId/sessions', { model: 'claude-agent/gpt-9' }, { params });
      unknown.status(400).body().has('$.code', 'INVALID_SESSION_MODEL');
      if (!unknown.text().includes(VALID)) throw new Error('the create refusal does not list the valid ids');
      (await owner.post('/v1/workspaces/:projectId/sessions', { model: 'claude-agent/opus', initial_prompt: 'hello' }, { params }))
        .status(409).body().has('$.code', 'claude_subscription_required').has('$.model', 'claude-agent/opus');
    });

    await ctx.step('session model change: a known Claude id is stored as-is; an unknown one → 400', async () => {
      const changed = await owner.put('/v1/workspaces/:projectId/sessions/:sessionId/model', { model: 'claude-agent/haiku' }, { params: sessionParams });
      if (changed.statusCode !== 200 && changed.statusCode !== 202) throw new Error(`model change returned ${changed.statusCode}: ${changed.text()}`);
      if (!changed.text().includes('claude-agent/haiku') || changed.text().includes('kortix/claude-agent')) {
        throw new Error(`the stored model is not claude-agent/haiku as-is: ${changed.text()}`);
      }
      const refused = await owner.put('/v1/workspaces/:projectId/sessions/:sessionId/model', { model: 'claude-agent/gpt-9' }, { params: sessionParams });
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
      (await owner.put('/v1/workspaces/:projectId/model-access', { target: 'model', id: 'claude-agent/fable', enabled: false }, { params })).status(200);
      const models = (await owner.get('/v1/workspaces/:projectId/model-picker', { params })).json<any>().claudeSubscription.models as any[];
      const enabled = Object.fromEntries(models.map((model) => [model.id, model.enabled]));
      if (enabled['claude-agent/fable'] !== false || enabled['claude-agent/opus'] !== true) throw new Error(`enabled after turning fable off: ${JSON.stringify(enabled)}`);
      const switched = await owner.put('/v1/workspaces/:projectId/sessions/:sessionId/model', { model: 'claude-agent/fable' }, { params: sessionParams });
      if (switched.statusCode < 400) throw new Error(`a session switched to a turned-off model: ${switched.statusCode}`);
      (await owner.put('/v1/workspaces/:projectId/model-access', { target: 'model', id: 'claude-agent/fable', enabled: true }, { params })).status(200);
    });

    await ctx.step('after the login the picker reads connected and the prompt passes the Claude gate', async () => {
      (await owner.put('/v1/workspaces/:projectId/claude-subscription/token', { token: TOKEN }, { params })).status(200);
      (await owner.get('/v1/workspaces/:projectId/model-picker', { params })).status(200).body()
        .has('$.claudeSubscription.connected', true).has('$.claudeSubscription.models[0].connected', true);
      const passed = await prompt({ providerID: 'claude-agent', modelID: 'opus' }, 'claude-gate-2');
      if (passed.statusCode === 409 && passed.text().includes('claude_subscription_required')) throw new Error('the gate refused a connected person');
      (await owner.del('/v1/workspaces/:projectId/claude-subscription', { params })).status(200);
    });
  },
);

flow(
  'SEC-CLAUDE-3',
  {
    domain: 'secrets',
    routes: [
      'PUT /v1/workspaces/:projectId/claude-subscription/token',
      'PUT /v1/workspaces/:projectId/custom-providers/:providerId',
      'POST /v1/workspaces/:projectId/secrets',
      'PUT /v1/workspaces/:projectId/gateway/routing-policy',
      'POST /v1/accounts/tokens',
      'POST /v1/llm/chat/completions',
      'GET /v1/workspaces/:projectId/sessions/:sessionId',
    ],
  },
  async (ctx) => {
    const { createServer } = await import('node:http');
    const { Client: PgClient } = await import('pg');
    const received: string[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model?: string };
        received.push(body.model ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion', created: 0, model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'FALLBACK-OK' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
      });
    });
    const port = await new Promise<number>((resolve) =>
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port)));
    const databaseUrl = ctx.env.databaseUrl as string;
    const db = new PgClient({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });

    const team = await ctx.fixtures.team();
    const project = await team.project();
    const holder = await team.addMember('member');
    await team.grantProjectRole(project.id, holder.userId!, 'manager');
    const asHolder = ctx.client.as(holder);
    const params = { projectId: project.id };
    const provider = `stub-${Date.now().toString(36)}`;
    const fallback = `${provider}/m1`;
    let sessionId = '';
    let claudeAccount = '';
    let sessionKey = '';
    const step = () => new Client(ctx.env.gatewayUrl).withBearer(sessionKey, 'BOUND_SESSION')
      .post('/v1/llm/chat/completions', { model: 'claude-agent/opus', messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 8 });

    try {
      await db.connect();
      await ctx.step('a manager connects a Claude account, a stub model and a Routing chain that ends at the stub', async () => {
        claudeAccount = (await asHolder.put('/v1/workspaces/:projectId/claude-subscription/token', { token: TOKEN }, { params }))
          .status(200).json<{ secret_id: string }>().secret_id;
        (await asHolder.put('/v1/workspaces/:projectId/custom-providers/:providerId',
          { name: 'Stub LLM', base_url: `http://127.0.0.1:${port}/v1/`, models: [{ id: 'm1', name: 'Model One' }] },
          { params: { ...params, providerId: provider } })).status(200);
        (await asHolder.post('/v1/workspaces/:projectId/secrets', {
          name: `CUSTOM_${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`, value: 'sk-stub-key', strategy: 'broker', consumer: 'llm_gateway',
        }, { params })).status(200);
        (await asHolder.put('/v1/workspaces/:projectId/gateway/routing-policy',
          { defaultModel: null, visionModel: null, defaultFallback: { models: [fallback], fallbackOn: 'transient' }, rules: [] },
          { params })).status(200);
      });

      await ctx.step("the holder's private session on claude-agent/opus gets its sandbox credential", async () => {
        sessionId = await createDatabaseSession(ctx.env, {
          projectId: project.id, accountId: team.id, userId: holder.userId!, visibility: 'private',
          metadata: { model: 'claude-agent/opus', model_source: 'explicit' },
        });
        const minted = (await asHolder.post('/v1/accounts/tokens', { name: 'Claude session', account_id: team.id })).status(201)
          .json<{ token_id: string; secret_key: string }>();
        await db.query("INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES ($1::uuid, $1, $2, $3, 'active')", [sessionId, team.id, project.id]);
        await db.query('UPDATE kortix.account_tokens SET project_id = $2, session_id = $3, agent_grant = $4::jsonb, account_id = $5 WHERE token_id = $1', [
          minted.token_id, project.id, sessionId, JSON.stringify({ agent: 'worker', permissions: 'all', connectors: 'all', env: 'all' }), team.id,
        ]);
        sessionKey = minted.secret_key;
      });

      await ctx.step("every Claude account at its usage limit → the step is served by the project's fallback, and the session moves to it", async () => {
        await db.query("UPDATE kortix.account_secret_resources SET cooldown_until = now() + interval '3 hours', cooldown_probe_at = now() + interval '1 hour' WHERE secret_id = $1", [claudeAccount]);
        (await step()).status(200)
          .headerEquals('x-kortix-requested-model', 'claude-agent/opus')
          .headerEquals('x-kortix-model', fallback)
          .body().has('$.choices[0].message.content', 'FALLBACK-OK');
        if (received.at(-1) !== 'm1') throw new Error(`the stub received ${JSON.stringify(received)}`);
        const metadata = await waitFor(async () => (await asHolder.get('/v1/workspaces/:projectId/sessions/:sessionId', { params: { ...params, sessionId } }))
          .status(200).json<{ metadata?: Record<string, unknown> }>().metadata ?? {}, {
          until: (value) => value.model_source === 'fallback',
          timeoutMs: 10_000,
          intervalMs: 250,
          description: 'the session moves to the fallback model',
        });
        if (metadata.model !== `kortix/${fallback}` || metadata.model_fallback_from !== 'claude-agent/opus'
          || metadata.model_fallback_reason !== 'provider_pool_rate_limited') {
          throw new Error(`session model after the fallback: ${JSON.stringify(metadata)}`);
        }
      });
    } finally {
      upstream.close();
      if (sessionId) await db.query('DELETE FROM kortix.session_sandboxes WHERE session_id = $1', [sessionId]).catch(() => {});
      await db.end().catch(() => {});
    }
  },
);

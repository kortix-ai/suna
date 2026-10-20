import { flow } from '../core/flow';
import { Client } from '../core/client';

// GW-CUSTOM-1 — a project's own OpenAI-compatible endpoint, served by the LLM
// gateway. A loopback stub plays the endpoint; the local stack allowlists
// 127.0.0.1 (KORTIX_LLM_CUSTOM_PROVIDER_ALLOW_HOSTS) and nothing else.
flow('GW-CUSTOM-1', {
  domain: 'llm-gateway',
  routes: [
    'GET /v1/projects/:projectId/custom-providers',
    'PUT /v1/projects/:projectId/custom-providers/:providerId',
    'DELETE /v1/projects/:projectId/custom-providers/:providerId',
    'POST /v1/projects/:projectId/secrets',
    'GET /v1/projects/:projectId/model-picker',
    'POST /v1/projects/:projectId/gateway/keys',
    'POST /v1/llm/chat/completions',
  ],
}, async (ctx) => {
  const { createServer } = await import('node:http');
  const received: Array<{ path: string; authorization: string | undefined; model: string }> = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model?: string };
      received.push({ path: req.url ?? '', authorization: req.headers.authorization, model: body.model ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'CUSTOM-OK' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  const port = await new Promise<number>((resolve) =>
    upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port)));

  const team = await ctx.fixtures.team();
  const member = await team.addMember('member');
  const project = await team.project();
  await team.grantProjectRole(project.id, member.userId!, 'user');
  const owner = ctx.client.as(ctx.P.OWNER);
  const params = { projectId: project.id };
  const id = `stub-${Date.now().toString(36)}`;
  const one = { projectId: project.id, providerId: id };
  const path = '/v1/projects/:projectId/custom-providers/:providerId';
  const list = '/v1/projects/:projectId/custom-providers';
  const secretName = `CUSTOM_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  const body = { name: 'Stub LLM', base_url: `http://127.0.0.1:${port}/v1/`, models: [{ id: 'm1', name: 'Model One' }] };
  const gateway = new Client(ctx.env.gatewayUrl);
  let key = '';
  const chat = (model: string) => gateway.withBearer(key, 'PROJECT_GATEWAY_KEY')
    .post('/v1/llm/chat/completions', { model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 8 });

  try {
    await ctx.step('anonymous, nonmember and member callers cannot change custom providers', async () => {
      (await ctx.client.as(ctx.P.ANON).get(list, { params })).status(401);
      (await ctx.client.as(ctx.P.NONMEMBER).get(list, { params })).status([403, 404]);
      (await ctx.client.as(ctx.P.NONMEMBER).put(path, body, { params: one })).status([403, 404]);
      (await ctx.client.as(member).get(list, { params })).status(200).body().has('$.providers', []);
      (await ctx.client.as(member).put(path, body, { params: one })).status(403);
    });

    await ctx.step('a bad id, a catalog id, a bad URL and a private address are refused', async () => {
      (await owner.put(path, body, { params: { ...one, providerId: 'Bad Id' } })).status(400).body().has('$.code', 'invalid_body');
      (await owner.put(path, body, { params: { ...one, providerId: 'anthropic' } })).status(400).body().has('$.code', 'reserved_provider_id');
      (await owner.put(path, { ...body, base_url: 'ftp://127.0.0.1/v1' }, { params: one })).status(400);
      (await owner.put(path, { ...body, models: [] }, { params: one })).status(400);
      (await owner.put(path, { ...body, base_url: 'http://10.0.0.1/v1' }, { params: one })).status(400).body().has('$.code', 'unsafe_base_url');
      (await owner.get(list, { params })).status(200).body().has('$.providers', []);
    });

    await ctx.step('the owner saves the endpoint and its key; the list and the picker show it', async () => {
      (await owner.put(path, body, { params: one })).status(200).body()
        .has('$.id', id).has('$.base_url', `http://127.0.0.1:${port}/v1`).has('$.secret_name', secretName)
        .has('$.has_key', false).has('$.configured', true).has('$.models', [{ id: 'm1', name: 'Model One' }]);
      (await owner.post('/v1/projects/:projectId/secrets', {
        name: secretName, value: 'sk-stub-key', strategy: 'broker', consumer: 'llm_gateway',
      }, { params })).status(200);
      (await owner.get(list, { params })).status(200).body()
        .has('$.providers[0].id', id).has('$.providers[0].has_key', true);
      const picker = (await owner.get('/v1/projects/:projectId/model-picker', { params }))
        .status(200).json<{ models: Record<string, { provider?: string; provider_name?: string; enabled?: boolean }> }>();
      const model = picker.models[`${id}/m1`];
      if (model?.provider !== id || model.provider_name !== 'Stub LLM' || model.enabled !== true) {
        throw new Error(`picker entry ${id}/m1: ${JSON.stringify(model)}`);
      }
    });

    await ctx.step('a gateway request reaches the endpoint with the key and the bare model id', async () => {
      const minted = await owner.post('/v1/projects/:projectId/gateway/keys', { name: 'custom provider' }, { params });
      minted.status(200);
      key = minted.json<{ secret_key: string }>().secret_key;
      (await chat(`${id}/m1`)).status(200).body().has('$.choices[0].message.content', 'CUSTOM-OK');
      const last = received.at(-1);
      if (last?.path !== '/v1/chat/completions' || last.authorization !== 'Bearer sk-stub-key' || last.model !== 'm1') {
        throw new Error(`stub saw ${JSON.stringify(last)}`);
      }
      (await chat(`${id}/not-listed`)).status(400).body().has('$.error.code', 'model_not_found');
    });

    await ctx.step('a key with no endpoint lists as configured: false', async () => {
      (await owner.post('/v1/projects/:projectId/secrets', {
        name: 'CUSTOM_LEGACY_API_KEY', value: 'sk-legacy', strategy: 'broker', consumer: 'llm_gateway',
      }, { params })).status(200);
      const providers = (await owner.get(list, { params })).status(200).json<{ providers: Array<{ id: string; configured: boolean; base_url: string | null }> }>().providers;
      const legacy = providers.find((provider) => provider.id === 'legacy');
      if (!legacy || legacy.configured || legacy.base_url !== null) throw new Error(`legacy row: ${JSON.stringify(legacy)}`);
    });

    await ctx.step('removing the endpoint takes its models out of the picker and the gateway', async () => {
      (await ctx.client.as(member).del(path, { params: one })).status(403);
      (await owner.del(path, { params: one })).status(204);
      (await owner.del(path, { params: one })).status(404);
      const picker = (await owner.get('/v1/projects/:projectId/model-picker', { params })).status(200).json<{ models: Record<string, unknown> }>();
      if (picker.models[`${id}/m1`]) throw new Error('removed custom model is still in the picker');
      (await chat(`${id}/m1`)).status(400).body().has('$.error.code', 'model_not_found');
    });
  } finally {
    upstream.close();
  }
});

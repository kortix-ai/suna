import { TokenBucketRateLimiter } from '../shared/rate-limit';
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { combinedAuth } from '../middleware/auth';
import type { AppEnv } from '../types';
import { providerConnectionAdapter, providerConnectionAdapters } from './adapters';
import { seal, unseal } from './crypto';
import { deleteUserProviderConnection, listUserProviderConnections, saveUserProviderConnection } from './store';

export const providerConnectionsApp = makeOpenApiApp<AppEnv>();
providerConnectionsApp.use('*', combinedAuth);
providerConnectionsApp.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // Account/project/agent tokens cannot acquire authority over a global user credential.
  if (c.get('authType') !== 'supabase' || c.get('impersonationGrantId')) {
    return c.json({ error: 'Sign in to manage personal provider connections' }, 403);
  }
  return next();
});
const limiter = new TokenBucketRateLimiter('user_provider_connections');
providerConnectionsApp.use('*', async (c, next) => {
  if (c.req.method === 'GET') return next();
  const poll = c.req.path.endsWith('/poll');
  const budget = limiter.check(`${c.get('userId')}:${poll ? 'poll' : 'write'}`, {
    limit: poll ? 30 : 10, windowMs: 60_000,
  });
  if (!budget.allowed) {
    c.header('Retry-After', String(Math.ceil((budget.retryAfterMs ?? budget.resetMs) / 1000)));
    return c.json({ error: 'Too many provider connection requests. Try again shortly.' }, 429);
  }
  return next();
});
const params = z.object({ provider: z.string().min(1).max(128) });
const responses = { 200: json(z.any(), 'Provider connection'), ...errors(400, 401, 403, 404, 429, 502) };

providerConnectionsApp.openapi(createRoute({ method: 'get', path: '/', tags: ['providers'], ...auth, responses }), async (c) => {
  const providers = providerConnectionAdapters().map(({ id, name, authType }) => ({ provider_id: id, name, auth_type: authType }));
  return c.json({ providers, items: await listUserProviderConnections(c.get('userId')) });
});

providerConnectionsApp.openapi(createRoute({ method: 'put', path: '/{provider}', tags: ['providers'], ...auth,
  request: { params, body: { content: { 'application/json': { schema: z.object({ api_key: z.string().trim().min(1).max(32768) }).strict() } } } }, responses }), async (c) => {
  const { provider } = c.req.valid('param');
  if (providerConnectionAdapter(provider)?.authType !== 'api_key') return c.json({ error: 'Provider does not accept an API key' }, 400);
  return c.json(await saveUserProviderConnection(c.get('userId'), provider, c.req.valid('json').api_key));
});

providerConnectionsApp.openapi(createRoute({ method: 'delete', path: '/{provider}', tags: ['providers'], ...auth,
  request: { params }, responses }), async (c) => {
  await deleteUserProviderConnection(c.get('userId'), c.req.valid('param').provider);
  return c.json({ ok: true });
});

providerConnectionsApp.openapi(createRoute({ method: 'post', path: '/{provider}/start', tags: ['providers'], ...auth,
  request: { params }, responses }), async (c) => {
  const { provider } = c.req.valid('param');
  const adapter = providerConnectionAdapter(provider);
  if (!adapter?.start) return c.json({ error: 'Device authorization is unavailable for this provider' }, 400);
  try {
    const challenge = await adapter.start();
    const expiresAt = Date.now() + 15 * 60_000;
    return c.json({ flow_id: seal(c.get('userId'), provider, 'flow', JSON.stringify({
      deviceAuthId: challenge.deviceAuthId, userCode: challenge.userCode, expiresAt,
    })), verification_url: challenge.verificationUrl, user_code: challenge.userCode,
      expires_at: expiresAt, interval_ms: Math.max(3000, challenge.intervalMs) });
  } catch {
    return c.json({ error: 'Provider authorization is unavailable. Try again.' }, 502);
  }
});

providerConnectionsApp.openapi(createRoute({ method: 'post', path: '/{provider}/poll', tags: ['providers'], ...auth,
  request: { params, body: { content: { 'application/json': { schema: z.object({ flow_id: z.string().min(1).max(16384) }).strict() } } } }, responses }), async (c) => {
  const { provider } = c.req.valid('param');
  const userId = c.get('userId');
  const adapter = providerConnectionAdapter(provider);
  if (!adapter?.poll) return c.json({ error: 'Device authorization is unavailable for this provider' }, 400);
  let state: { deviceAuthId: string; userCode: string; expiresAt: number };
  try {
    state = JSON.parse(unseal(userId, provider, 'flow', c.req.valid('json').flow_id));
    if (!state.deviceAuthId || !state.userCode || !Number.isFinite(state.expiresAt) || Date.now() >= state.expiresAt) throw new Error('Expired');
  } catch { return c.json({ status: 'expired' }); }
  try {
    const result = await adapter.poll(state);
    if (result.status !== 'authorized') return c.json(result);
    const connection = await saveUserProviderConnection(userId, provider, result.authJson);
    return c.json({ status: 'success', connection });
  } catch { return c.json({ error: 'Provider authorization is unavailable. Try again.' }, 502); }
});

import { createRoute, z } from '@hono/zod-openapi';
import { makeOpenApiApp, json, errors, auth } from '../openapi';
import { config } from '../config';
import { supabaseAuth } from '../middleware/auth';
import { actorOf } from '../iam/actor';
import { resolveAccountId } from '../shared/resolve-account';
import { requestClientKey } from '../middleware/client-ip';
import { TokenBucketRateLimiter } from '../shared/rate-limit';
import type { AppEnv } from '../types';
import { startCliGrant, pollCliGrant, decideCliGrant } from './device-grants';

// replica-local: abuse backstop, not grant storage or one-time enforcement.
const limiter = new TokenBucketRateLimiter('cli-device');
const Result = z.object({ error: z.string().optional(), token: z.string().optional() });

export function createCliDeviceRouter() {
  const router = makeOpenApiApp<AppEnv>();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // One bucket per budget: a shared bucket starts at whichever limit the
    // first call names, so start's 10 capped poll and decide at 10 too.
    const start = c.req.path.endsWith('/start');
    const key = `${start ? 'start' : 'poll'}:${requestClientKey(c)}`;
    if (!limiter.check(key, { limit: start ? 10 : 30, windowMs: 60_000 }).allowed) {
      return c.json({ error: 'slow_down' }, 429);
    }
    await next();
  });
  router.openapi(createRoute({
    method: 'post', path: '/start', tags: ['cli'], summary: 'Start CLI device login',
    responses: { 200: json(z.object({ device_code: z.string(), user_code: z.string(), expires_in: z.number(), interval: z.number(), verification_uri: z.string() }), 'Device grant'), ...errors(429) },
  }), async c => c.json({ ...await startCliGrant(), verification_uri: `${config.FRONTEND_URL.replace(/\/+$/, '')}/cli/authorize` }, 200));
  router.openapi(createRoute({
    method: 'post', path: '/poll', tags: ['cli'], summary: 'Poll CLI device login',
    request: { body: { required: true, content: { 'application/json': { schema: z.object({ device_code: z.string().regex(/^[a-f0-9]{64}$/) }) } } } },
    responses: { 200: json(Result, 'Token or pending grant'), ...errors(400, 429) },
  }), async c => c.json(await pollCliGrant(c.req.valid('json').device_code), 200));
  router.use('/decide', supabaseAuth);
  router.openapi(createRoute({
    method: 'post', path: '/decide', tags: ['cli'], summary: 'Approve or deny CLI login', ...auth,
    request: { body: { required: true, content: { 'application/json': { schema: z.object({ user_code: z.string().regex(/^[a-fA-F0-9-]{16,20}$/), approve: z.boolean() }) } } } },
    responses: { 200: json(z.object({ ok: z.boolean() }), 'Grant decided'), ...errors(400, 401, 403, 404, 429) },
  }), async c => {
    if (c.get('authType') !== 'supabase') return c.json({ error: 'Sign in with a browser session to approve CLI login.' }, 403);
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const actor = await actorOf(c, accountId);
    const body = c.req.valid('json');
    if (!await decideCliGrant(body.user_code, actor, body.approve)) return c.json({ error: 'Login code expired or already used.' }, 404);
    return c.json({ ok: true }, 200);
  });
  return router;
}

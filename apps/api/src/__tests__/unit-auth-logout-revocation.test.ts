import { expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthVariables } from '../types';

const USER = '00000000-0000-4000-8000-00000000a001';
const SECRET = 'synthetic-logout-secret-0123456789';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.SUPABASE_JWT_LIVENESS_TTL_MS = '0';

mock.module('../shared/db', () => ({ db: {}, hasDatabase: () => false }));
mock.module('../middleware/auth-audit', () => ({
  auditLoginFail: () => {}, auditLoginSuccess: () => {}, auditLogout: () => {}, auditSessionFirstSight: () => {},
}));
mock.module('../middleware/auth-principal', () => ({
  serviceAccountPrincipal: () => {}, patPrincipal: () => {},
  jwtPrincipal: async (c: { set: (key: string, value: string) => void }, userId: string) => {
    c.set('userId', userId);
    c.set('authType', 'supabase');
  },
}));
mock.module('../middleware/auth-actor', () => ({ withActor: async (_c: unknown, next: () => Promise<void>) => next() }));
mock.module('../middleware/impersonation', () => ({ applyImpersonation: async (_c: unknown, next: () => Promise<void>) => next() }));

const { __setGoTrueFetch } = await import('../auth/gotrue');
const { __setJwtLivenessLoaderForTests } = await import('../shared/jwt-liveness');
const { authRouter } = await import('../auth');
const { supabaseAuth } = await import('../middleware/auth');

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: USER, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
const bearer = `${unsigned}.${createHmac('sha256', SECRET).update(unsigned).digest('base64url')}`;

const app = new Hono<{ Variables: AuthVariables }>();
app.route('/v1/auth', authRouter);
app.use('/v1/accounts/me', supabaseAuth);
app.get('/v1/accounts/me', (c) => c.json({ user_id: c.get('userId') }));
app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: 'unexpected' }, 500));
const request = (path: string, method = 'GET') => app.request(path, { method, headers: { authorization: `Bearer ${bearer}` } });

test('POST /v1/auth/logout revokes the bearer used by the next authenticated identity request', async () => {
  let live = true;
  let checks = 0;
  __setJwtLivenessLoaderForTests(async () => {
    checks++;
    return live ? { id: USER, email: '' } : null;
  });
  __setGoTrueFetch(async (_url, init) => {
    if (init.method === 'POST') live = false;
    return Response.json({});
  });
  try {
    expect((await request('/v1/accounts/me')).status).toBe(200);
    const logout = await request('/v1/auth/logout', 'POST');
    expect(logout.status).toBe(200);
    expect((await request('/v1/accounts/me')).status).toBe(401);
    expect(checks).toBe(3);
  } finally {
    __setJwtLivenessLoaderForTests(null);
    __setGoTrueFetch(null);
  }
});

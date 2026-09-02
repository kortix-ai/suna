import { getEnv } from '../lib/get-env';
import { getAuth } from './generated/auth';
import type { GenericCtx } from './generated/server';
import { cors } from 'hono/cors';
import { authMiddleware } from 'kitcn/auth/http';
import { createHttpRouter } from 'kitcn/server';
import { Hono } from 'hono';
import { router } from '../lib/crpc';
// __KITCN_HTTP_IMPORTS__

const app = new Hono();
// kitcn passes the Convex http-action ctx as Hono's env.
const authFor = (env: unknown) => getAuth(env as GenericCtx);

app.use(
  '/api/*',
  cors({
    origin: getEnv().SITE_URL,
    allowHeaders: ['Content-Type', 'Authorization', 'Better-Auth-Cookie'],
    exposeHeaders: ['Set-Better-Auth-Cookie'],
    credentials: true,
  })
);

// OAuth 2.1 authorization-server metadata (RFC 8414) and the MCP protected-resource
// document (RFC 9728) are served by Better Auth's request hooks at the site root,
// not under /api/auth. Forward root well-known lookups to the auth handler.
app.all('/.well-known/oauth-authorization-server', (c) => authFor(c.env).handler(c.req.raw));
app.all('/.well-known/oauth-protected-resource', (c) => authFor(c.env).handler(c.req.raw));
app.all('/.well-known/oauth-protected-resource/*', (c) => authFor(c.env).handler(c.req.raw));

app.use(authMiddleware(getAuth));

export const httpRouter = router({
  // __KITCN_HTTP_ROUTES__
});

export default createHttpRouter(app, httpRouter);

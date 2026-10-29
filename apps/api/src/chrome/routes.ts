/**
 * Kortix in Chrome REST routes.
 *
 *   /v1/chrome/connections[/:id]          user routes: JWT, `kortix_pat_` or `kortix_oat_`
 *   /v1/chrome/attach|release  sandbox routes: a session-scoped sandbox credential only
 *   /v1/chrome/panel-session   the extension's own `kortix_oat_` token only (side panel sign-in)
 *
 * The control socket (`/v1/chrome/ws`) is upgraded in inbound-dispatch.ts.
 * Protocol: .agents/skills/kortix-chrome/references/protocol.md
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { config } from '../config';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { featureDisabledBody } from '../feature-flags/gate';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { isSessionSandboxCredential } from '../middleware/session-sandbox-credential';
import { isUuid } from '../shared/validate';
import type { AppEnv } from '../types';
import { ChromeError, chromeErrorBody, type ChromeErrorCode } from './logic';
import { createPanelSession, PanelRateLimited } from './panel';
import { attachChrome, deleteChromeConnection, listChromeConnectionDtos, patchChrome, releaseChrome } from './service';

export const chromeConnectionsApp = makeOpenApiApp<AppEnv>();
export const chromeApp = makeOpenApiApp<AppEnv>();

const ActiveSessionSchema = z.object({ sessionId: z.string(), projectId: z.string(), title: z.string() });

const ChromeSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    brand: z.string(),
    os: z.string(),
    profileLabel: z.string().nullable(),
    extensionVersion: z.string().nullable(),
    accessMode: z.enum(['always', 'ask', 'off']),
    tabScope: z.enum(['own', 'all']),
    online: z.boolean(),
    lastSeenAt: z.string().nullable(),
    createdAt: z.string(),
    activeSessions: z.array(ActiveSessionSchema),
  })
  .openapi('ChromeConnection');

const PatchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    accessMode: z.enum(['always', 'ask', 'off']).optional(),
    tabScope: z.enum(['own', 'all']).optional(),
  })
  .strict()
  .openapi('PatchChromeRequest');

const AttachBodySchema = z
  .object({
    chrome: z.string().trim().min(1).max(255).optional(),
    ticket: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/),
    ask: z.boolean().default(false),
  })
  .openapi('AttachChromeRequest');

const ReleaseBodySchema = z.object({ attachmentId: z.string().uuid() }).openapi('ReleaseChromeRequest');

const IdParams = z.object({ id: z.string().min(1) });

function fail(c: Context, code: ChromeErrorCode, status: 403 | 404 | 408 | 409) {
  return c.json(chromeErrorBody(code, config.FRONTEND_URL), status);
}

function notFound(c: Context) {
  return fail(c, 'chrome_not_found', 404);
}

/**
 * Until launch, Kortix in Chrome exists only where KORTIX_CHROME_ENABLED is on
 * (local and dev). Off, every /v1/chrome route answers 404, so the extension
 * says this server does not have Kortix in Chrome.
 */
export const chromeMasterSwitch: MiddlewareHandler = async (c, next) => {
  if (!config.KORTIX_CHROME_ENABLED) return c.json({ error: 'Not found' }, 404);
  await next();
};

export function registerChromeRoutes(): void {
  chromeConnectionsApp.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['chrome'],
      summary: "List the caller's connected browsers",
      ...auth,
      responses: { 200: json(z.array(ChromeSchema), 'Chrome connections, newest last seen first'), ...errors(401) },
    }),
    async (c) => c.json(await listChromeConnectionDtos(c.get('userId')), 200),
  );

  chromeConnectionsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['chrome'],
      summary: 'Rename a browser or change its access mode or tab scope',
      ...auth,
      request: {
        params: IdParams,
        body: { content: { 'application/json': { schema: PatchBodySchema } } },
      },
      responses: { 200: json(ChromeSchema, 'The updated browser'), ...errors(401, 404) },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!isUuid(id)) return notFound(c) as never;
      const dto = await patchChrome(c.get('userId'), id, c.req.valid('json'));
      return dto ? c.json(dto, 200) : (notFound(c) as never);
    },
  );

  chromeConnectionsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['chrome'],
      summary: 'Disconnect a browser from Kortix',
      ...auth,
      request: { params: IdParams },
      responses: { 204: { description: 'Connection revoked' }, ...errors(401, 404) },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!isUuid(id) || !(await deleteChromeConnection(c.get('userId'), id))) return notFound(c) as never;
      return c.body(null, 204);
    },
  );

  chromeApp.openapi(
    createRoute({
      method: 'post',
      path: '/attach',
      tags: ['chrome'],
      summary: "Attach the calling session to one of the owner's browsers (sandbox credential only)",
      ...auth,
      request: { body: { content: { 'application/json': { schema: AttachBodySchema } } } },
      responses: {
        200: json(z.object({ attachmentId: z.string().uuid(), chrome: ChromeSchema }), 'Attached'),
        ...errors(401, 403, 404, 408, 409),
      },
    }),
    async (c) => {
      const session = sandboxSession(c);
      if (!session) return c.json({ error: 'browser attach requires a session sandbox token' }, 403) as never;
      // Release stays open when the flag is off, so a session can always let go.
      if (!(await projectFeatureFlagEnabled(session.projectId, 'chrome'))) {
        return c.json(featureDisabledBody('chrome'), 403) as never;
      }
      const body = c.req.valid('json');
      try {
        const result = await attachChrome({ ...session, chrome: body.chrome, ticket: body.ticket, ask: body.ask });
        return c.json(result, 200);
      } catch (err) {
        if (err instanceof ChromeError) return fail(c, err.code, err.status) as never;
        throw err;
      }
    },
  );

  chromeApp.openapi(
    createRoute({
      method: 'post',
      path: '/panel-session',
      tags: ['chrome'],
      summary: 'Mint a one-time sign-in token for the extension side panel (extension OAuth token only)',
      ...auth,
      responses: {
        200: json(z.object({ tokenHash: z.string() }), 'A single-use token hash for supabase.auth.verifyOtp'),
        ...errors(401, 403, 409, 429),
      },
    }),
    async (c) => {
      try {
        const result = await createPanelSession({
          userId: c.get('userId'),
          authType: c.get('authType'),
          oauthClientId: c.get('oauthClientId'),
        });
        c.header('Cache-Control', 'no-store');
        return c.json(result, 200);
      } catch (err) {
        if (err instanceof ChromeError) return fail(c, err.code, err.status) as never;
        if (err instanceof PanelRateLimited) {
          c.header('Retry-After', String(err.retryAfterSeconds));
          return c.json({ error: err.message }, 429) as never;
        }
        throw err;
      }
    },
  );

  chromeApp.openapi(
    createRoute({
      method: 'post',
      path: '/release',
      tags: ['chrome'],
      summary: 'Release the browser the calling session attached (sandbox credential only)',
      ...auth,
      request: { body: { content: { 'application/json': { schema: ReleaseBodySchema } } } },
      responses: { 204: { description: 'Released' }, ...errors(401, 403) },
    }),
    async (c) => {
      const session = sandboxSession(c);
      if (!session) return c.json({ error: 'browser release requires a session sandbox token' }, 403) as never;
      await releaseChrome({ sessionId: session.sessionId, attachmentId: c.req.valid('json').attachmentId });
      return c.body(null, 204);
    },
  );
}

/** The owner, session and project of a session-scoped sandbox credential. */
function sandboxSession(c: Context<AppEnv>): { userId: string; sessionId: string; projectId: string } | null {
  if (!isSessionSandboxCredential(c)) return null;
  const sessionId = c.get('sessionId');
  const projectId = c.get('tokenProjectId');
  const userId = c.get('userId');
  return sessionId && projectId && userId ? { userId, sessionId, projectId } : null;
}

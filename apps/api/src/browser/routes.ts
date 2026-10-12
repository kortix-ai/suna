/**
 * Kortix Browser REST routes.
 *
 *   /v1/browsers[/:id]          user routes: JWT, `kortix_pat_` or `kortix_oat_`
 *   /v1/browser/attach|release  sandbox routes: a session-scoped sandbox credential only
 *
 * The control socket (`/v1/browser/ws`) is upgraded in inbound-dispatch.ts.
 * Protocol: .agents/skills/kortix-browser/references/protocol.md
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { config } from '../config';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { isSessionSandboxCredential } from '../middleware/session-sandbox-credential';
import { isUuid } from '../shared/validate';
import type { AppEnv } from '../types';
import { BrowserError, browserErrorBody, type BrowserErrorCode } from './logic';
import { attachBrowser, deleteBrowser, listBrowserDtos, patchBrowser, releaseBrowser } from './service';

export const browsersApp = makeOpenApiApp<AppEnv>();
export const browserApp = makeOpenApiApp<AppEnv>();

const ActiveSessionSchema = z.object({ sessionId: z.string(), projectId: z.string(), title: z.string() });

const BrowserSchema = z
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
  .openapi('Browser');

const PatchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    accessMode: z.enum(['always', 'ask', 'off']).optional(),
    tabScope: z.enum(['own', 'all']).optional(),
  })
  .strict()
  .openapi('PatchBrowserRequest');

const AttachBodySchema = z
  .object({
    browser: z.string().trim().min(1).max(255).optional(),
    ticket: z.string().regex(/^[A-Za-z0-9_-]{8,256}$/),
    ask: z.boolean().default(false),
  })
  .openapi('AttachBrowserRequest');

const ReleaseBodySchema = z.object({ attachmentId: z.string().uuid() }).openapi('ReleaseBrowserRequest');

const IdParams = z.object({ id: z.string().min(1) });

function fail(c: Context, code: BrowserErrorCode, status: 403 | 404 | 408 | 409) {
  return c.json(browserErrorBody(code, config.FRONTEND_URL), status);
}

function notFound(c: Context) {
  return fail(c, 'browser_not_found', 404);
}

export function registerBrowserRoutes(): void {
  browsersApp.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['browser'],
      summary: "List the caller's connected browsers",
      ...auth,
      responses: { 200: json(z.array(BrowserSchema), 'Browsers, newest last seen first'), ...errors(401) },
    }),
    async (c) => c.json(await listBrowserDtos(c.get('userId')), 200),
  );

  browsersApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['browser'],
      summary: 'Rename a browser or change its access mode or tab scope',
      ...auth,
      request: {
        params: IdParams,
        body: { content: { 'application/json': { schema: PatchBodySchema } } },
      },
      responses: { 200: json(BrowserSchema, 'The updated browser'), ...errors(401, 404) },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!isUuid(id)) return notFound(c) as never;
      const dto = await patchBrowser(c.get('userId'), id, c.req.valid('json'));
      return dto ? c.json(dto, 200) : (notFound(c) as never);
    },
  );

  browsersApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      tags: ['browser'],
      summary: 'Disconnect a browser from Kortix',
      ...auth,
      request: { params: IdParams },
      responses: { 204: { description: 'Browser revoked' }, ...errors(401, 404) },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!isUuid(id) || !(await deleteBrowser(c.get('userId'), id))) return notFound(c) as never;
      return c.body(null, 204);
    },
  );

  browserApp.openapi(
    createRoute({
      method: 'post',
      path: '/attach',
      tags: ['browser'],
      summary: "Attach the calling session to one of the owner's browsers (sandbox credential only)",
      ...auth,
      request: { body: { content: { 'application/json': { schema: AttachBodySchema } } } },
      responses: {
        200: json(z.object({ attachmentId: z.string().uuid(), browser: BrowserSchema }), 'Attached'),
        ...errors(401, 403, 404, 408, 409),
      },
    }),
    async (c) => {
      const session = sandboxSession(c);
      if (!session) return c.json({ error: 'browser attach requires a session sandbox token' }, 403) as never;
      const body = c.req.valid('json');
      try {
        const result = await attachBrowser({ ...session, browser: body.browser, ticket: body.ticket, ask: body.ask });
        return c.json(result, 200);
      } catch (err) {
        if (err instanceof BrowserError) return fail(c, err.code, err.status) as never;
        throw err;
      }
    },
  );

  browserApp.openapi(
    createRoute({
      method: 'post',
      path: '/release',
      tags: ['browser'],
      summary: 'Release the browser the calling session attached (sandbox credential only)',
      ...auth,
      request: { body: { content: { 'application/json': { schema: ReleaseBodySchema } } } },
      responses: { 204: { description: 'Released' }, ...errors(401, 403) },
    }),
    async (c) => {
      const session = sandboxSession(c);
      if (!session) return c.json({ error: 'browser release requires a session sandbox token' }, 403) as never;
      await releaseBrowser({ sessionId: session.sessionId, attachmentId: c.req.valid('json').attachmentId });
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

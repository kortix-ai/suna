import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import {
  DEFAULT_PREVIEW_CANDIDATES,
  createPublicShare,
  listPublicSharesForSession,
  revokePublicShare,
} from '../../shared/session-public-shares';
import { loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { guardSession, guardSessionSharing, sessionAccessDenied } from '../lib/session-access';
import { isUuid } from '../../shared/validate';
import { readJsonObject } from '../../shared/http-body';
import { sessionHasMemberConnectorBinding } from '../lib/session-connector-bindings';

// GET /v1/projects/:projectId/sessions/:sessionId/previews
// Human-friendly preview candidates. The frontend should pass the active
// browser/preview tab when it has one; this endpoint is a fallback list.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/previews',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/previews',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Preview candidates'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const guard = await guardSession(c, loaded, sessionId, 'read');
    if (!guard.ok) return sessionAccessDenied(c, guard);

    return c.json({
      candidates: DEFAULT_PREVIEW_CANDIDATES.map((candidate) => ({
        ...candidate,
        status: 'unknown',
      })),
    });
  },
);

// GET /v1/projects/:projectId/sessions/:sessionId/public-shares

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/public-shares',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/public-shares',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Public shares'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const guard = await guardSessionSharing(c, loaded, sessionId, 'list');
    if (!guard.ok) return sessionAccessDenied(c, guard);

    return c.json({ shares: await listPublicSharesForSession(sessionId) });
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/public-shares

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/public-shares',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/public-shares',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'The live transcript share this session already has'),
      201: json(z.any(), 'Public share'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const body = await readJsonObject(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Minting, not revoking: a public share link is unauthenticated, so this is
    // the owner's call. A manager who cannot read the session cannot mint one
    // and read it through the link instead.
    const guard = await guardSessionSharing(c, loaded, sessionId, 'mint');
    if (!guard.ok) return sessionAccessDenied(c, guard);
    const visible = guard.session;
    if (
      await sessionHasMemberConnectorBinding({
        accountId: visible.row.accountId,
        projectId,
        sessionId,
      })
    ) {
      return c.json(
        {
          error: 'Sessions using a personal connection cannot be shared publicly',
          code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
        },
        409,
      );
    }

    const result = await createPublicShare(body, {
      sessionId,
      projectId,
      accountId: visible.row.accountId,
      userId: loaded.userId,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as any);
    // A transcript share is one live link per session: minting again returns
    // the live link with 200 instead of a second one.
    return c.json({ share: result.share }, result.created ? 201 : 200);
  },
);

// DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/sessions/{sessionId}/public-shares/{shareId}',
    tags: ['sessions'],
    summary: 'DELETE /:projectId/sessions/:sessionId/public-shares/:shareId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string(), shareId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Revoked'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const shareId = c.req.param('shareId');
    if (!isUuid(sessionId) || !isUuid(shareId)) {
      return c.json({ error: 'Invalid id' }, 400);
    }

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Revoking only ever REMOVES access, so it stays manager-tier: a project
    // manager must be able to kill a leaking link without owning the session.
    const guard = await guardSessionSharing(c, loaded, sessionId, 'revoke');
    if (!guard.ok) return sessionAccessDenied(c, guard);

    const share = await revokePublicShare(sessionId, shareId);
    if (!share) return c.json({ error: 'Not found' }, 404);
    return c.json({ share });
  },
);

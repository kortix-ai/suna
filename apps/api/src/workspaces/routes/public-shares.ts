import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import {
  DEFAULT_PREVIEW_CANDIDATES,
  createPublicShare,
  listPublicSharesForSession,
  revokePublicShare,
} from '../../shared/session-public-shares';
import { loadWorkspaceForUser, loadSessionForSharing, loadVisibleSession } from '../lib/access';
import { AnyObject, workspaceRoutesApp } from '../lib/app';
import { UUID_V4_REGEX, readBody } from '../lib/serializers';
import { sessionHasMemberConnectorBinding } from '../lib/session-connector-bindings';

// GET /v1/workspaces/:workspaceId/sessions/:sessionId/previews
// Human-friendly preview candidates. The frontend should pass the active
// browser/preview tab when it has one; this endpoint is a fallback list.

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions/{sessionId}/previews',
    tags: ['sessions'],
    summary: 'GET /:workspaceId/sessions/:sessionId/previews',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Preview candidates'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);

    return c.json({
      candidates: DEFAULT_PREVIEW_CANDIDATES.map((candidate) => ({
        ...candidate,
        status: 'unknown',
      })),
    });
  },
);

// GET /v1/workspaces/:workspaceId/sessions/:sessionId/public-shares

workspaceRoutesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{workspaceId}/sessions/{sessionId}/public-shares',
    tags: ['sessions'],
    summary: 'GET /:workspaceId/sessions/:sessionId/public-shares',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Public shares'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const visible = await loadSessionForSharing(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!visible.canManageSharing) {
      return c.json({ error: 'Only the session owner or an editor can view public shares' }, 403);
    }

    return c.json({ shares: await listPublicSharesForSession(sessionId) });
  },
);

// POST /v1/workspaces/:workspaceId/sessions/:sessionId/public-shares

workspaceRoutesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{workspaceId}/sessions/{sessionId}/public-shares',
    tags: ['sessions'],
    summary: 'POST /:workspaceId/sessions/:sessionId/public-shares',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Public share'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const body = await readBody(c);
    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const visible = await loadSessionForSharing(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!visible.canManageSharing) {
      return c.json({ error: 'Only the session owner or an editor can create public shares' }, 403);
    }
    if (
      await sessionHasMemberConnectorBinding({
        accountId: visible.row.accountId,
        workspaceId,
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
      workspaceId,
      accountId: visible.row.accountId,
      userId: loaded.userId,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as any);
    return c.json({ share: result.share }, 201);
  },
);

// DELETE /v1/workspaces/:workspaceId/sessions/:sessionId/public-shares/:shareId

workspaceRoutesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{workspaceId}/sessions/{sessionId}/public-shares/{shareId}',
    tags: ['sessions'],
    summary: 'DELETE /:workspaceId/sessions/:sessionId/public-shares/:shareId',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), sessionId: z.string(), shareId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Revoked'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const workspaceId = c.req.param('workspaceId');
    const sessionId = c.req.param('sessionId');
    const shareId = c.req.param('shareId');
    if (!UUID_V4_REGEX.test(sessionId) || !UUID_V4_REGEX.test(shareId)) {
      return c.json({ error: 'Invalid id' }, 400);
    }

    const loaded = await loadWorkspaceForUser(c, workspaceId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const visible = await loadSessionForSharing(loaded, sessionId, c.get('sessionId') ?? null);
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!visible.canManageSharing) {
      return c.json({ error: 'Only the session owner or an editor can revoke public shares' }, 403);
    }

    const share = await revokePublicShare(sessionId, shareId);
    if (!share) return c.json({ error: 'Not found' }, 404);
    return c.json({ share });
  },
);

import { auth, errors, json } from '../../openapi';
import {
  DEFAULT_PREVIEW_CANDIDATES,
  createPublicShare,
  listPublicSharesForSession,
  revokePublicShare,
} from '../../shared/session-public-shares';
import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import { loadProjectForUser, loadVisibleSession } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { UUID_V4_REGEX, readBody } from '../lib/serializers';
import { attemptRoute, failJson, failNotFound, routeJson, runProjectRouteEffect } from './effect-workflows';

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
    return runProjectRouteEffect(c, Effect.gen(function* () {
      if (!UUID_V4_REGEX.test(sessionId)) return yield* failJson({ error: 'Invalid session id' }, 400);

      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, 'read'));
      if (!loaded) return yield* failNotFound();
      const visible = yield* attemptRoute(() => loadVisibleSession(loaded, sessionId));
      if (!visible) return yield* failNotFound();

      return routeJson({
        candidates: DEFAULT_PREVIEW_CANDIDATES.map((candidate) => ({
          ...candidate,
          status: 'unknown',
        })),
      });
    }));
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
    return runProjectRouteEffect(c, Effect.gen(function* () {
      if (!UUID_V4_REGEX.test(sessionId)) return yield* failJson({ error: 'Invalid session id' }, 400);

      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, 'read'));
      if (!loaded) return yield* failNotFound();
      const visible = yield* attemptRoute(() => loadVisibleSession(loaded, sessionId));
      if (!visible) return yield* failNotFound();
      if (!visible.canManageSharing) {
        return yield* failJson({ error: 'Only the session owner or a project manager can view public shares' }, 403);
      }

      const shares = yield* attemptRoute(() => listPublicSharesForSession(sessionId));
      return routeJson({ shares });
    }));
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
      201: json(z.any(), 'Public share'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    return runProjectRouteEffect(c, Effect.gen(function* () {
      if (!UUID_V4_REGEX.test(sessionId)) return yield* failJson({ error: 'Invalid session id' }, 400);

      const body = yield* attemptRoute(() => readBody(c));
      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, 'read'));
      if (!loaded) return yield* failNotFound();
      const visible = yield* attemptRoute(() => loadVisibleSession(loaded, sessionId));
      if (!visible) return yield* failNotFound();
      if (!visible.canManageSharing) {
        return yield* failJson({ error: 'Only the session owner or a project manager can create public shares' }, 403);
      }

      const result = yield* attemptRoute(() => createPublicShare(body, {
        sessionId,
        projectId,
        accountId: visible.row.accountId,
        userId: loaded.userId,
      }));
      if (!result.ok) return yield* failJson({ error: result.error }, result.status);
      return routeJson({ share: result.share }, 201);
    }));
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
    return runProjectRouteEffect(c, Effect.gen(function* () {
      if (!UUID_V4_REGEX.test(sessionId) || !UUID_V4_REGEX.test(shareId)) {
        return yield* failJson({ error: 'Invalid id' }, 400);
      }

      const loaded = yield* attemptRoute(() => loadProjectForUser(c, projectId, 'read'));
      if (!loaded) return yield* failNotFound();
      const visible = yield* attemptRoute(() => loadVisibleSession(loaded, sessionId));
      if (!visible) return yield* failNotFound();
      if (!visible.canManageSharing) {
        return yield* failJson({ error: 'Only the session owner or a project manager can revoke public shares' }, 403);
      }

      const share = yield* attemptRoute(() => revokePublicShare(sessionId, shareId));
      if (!share) return yield* failNotFound();
      return routeJson({ share });
    }));
  },
);

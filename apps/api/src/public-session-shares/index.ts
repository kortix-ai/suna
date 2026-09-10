/**
 * Anonymous metadata and sanitized transcripts for a valid public share UUID.
 * The shared resolver enforces revocation, expiration, and connector restrictions.
 * These views do not require a running environment. Conversation reads target
 * the worker and fall back to its durable transcript mirror.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { errors, json, makeOpenApiApp } from '../openapi';
import { UUID_V4_REGEX } from '../projects/lib/serializers';
import { createPublicSessionShareRateLimitMiddleware } from '../shared/rate-limit';
import { publicShareToken, resolvePublicShare } from '../shared/session-public-shares';
import { getPublicSessionInfo, getPublicSessionMessages } from '../shared/public-session-share-view';

export const publicSessionSharesApp = makeOpenApiApp();

publicSessionSharesApp.use('/:shareId', createPublicSessionShareRateLimitMiddleware());
publicSessionSharesApp.use('/:shareId/messages', createPublicSessionShareRateLimitMiddleware());

const ShareParams = z.object({ shareId: z.string() });

async function resolveShareId(shareId: string) {
  if (!UUID_V4_REGEX.test(shareId)) {
    return { ok: false as const, status: 400, error: 'Invalid share id' };
  }
  return resolvePublicShare(publicShareToken(shareId), { requireRuntime: false });
}

publicSessionSharesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{shareId}',
    tags: ['public-session-shares'],
    summary: 'GET /public/session-shares/:shareId — anonymous session view metadata',
    request: { params: ShareParams },
    responses: {
      200: json(z.any(), 'Share + session metadata'),
      ...errors(400, 403, 404, 410, 503),
    },
  }),
  async (c: any) => {
    const shareId = c.req.param('shareId');
    const resolved = await resolveShareId(shareId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);

    const info = await getPublicSessionInfo(resolved.row.sessionId);
    if (!info.ok) return c.json({ error: info.error }, info.status as any);

    return c.json({
      share: {
        share_id: resolved.row.shareId,
        session_id: resolved.row.sessionId,
        project_id: resolved.row.projectId,
        resource_type: resolved.row.resourceType,
        label: resolved.row.label,
        sandbox_status: resolved.row.sandboxStatus,
        expires_at: resolved.row.expiresAt?.toISOString() ?? null,
      },
      session: info.session,
    });
  },
);

publicSessionSharesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{shareId}/messages',
    tags: ['public-session-shares'],
    summary: 'GET /public/session-shares/:shareId/messages — anonymous sanitized transcript',
    request: { params: ShareParams },
    responses: {
      200: json(z.any(), 'Sanitized transcript'),
      ...errors(400, 403, 404, 410, 503),
    },
  }),
  async (c: any) => {
    const shareId = c.req.param('shareId');
    const resolved = await resolveShareId(shareId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);

    const result = await getPublicSessionMessages({
      sessionId: resolved.row.sessionId,
      externalId: resolved.row.workerExternalId,
      sandboxStatus: resolved.row.workerStatus,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as any);
    return c.json(result.transcript);
  },
);

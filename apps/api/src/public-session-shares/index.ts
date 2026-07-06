/**
 * Anonymous, read-only "view this session" surface — GET /v1/public/session-shares/:shareId
 * and GET /v1/public/session-shares/:shareId/messages.
 *
 * Backs `apps/web/src/app/(public)/share/[shareId]` (`ShareViewer.tsx`): a
 * logged-out visitor with a share link should see the session's title and a
 * read-only, sanitized transcript, with NO client-side sandbox access at all
 * — the API does the sandbox round-trip server-side and returns compacted
 * JSON (see `shared/public-session-share-view.ts`).
 *
 * `:shareId` is the share's raw `share_id` (the uuid primary key on
 * `project_session_public_shares` — the same value the CRUD routes call
 * `share_id` and the frontend's `[shareId]` route param already is), NOT the
 * `kps_...` public token. Every other public-share surface
 * (`/v1/p/public-share/:token`, `public_path: /share/session/:token`) is
 * keyed by the token instead, so accepting the bare id here — and deriving
 * the token server-side via the existing `publicShareToken()` — means the
 * frontend never needs to know the `kps_` derivation exists; it just forwards
 * the id already in its own URL. The two are equally sensitive: a token IS
 * `kps_` + the id with dashes stripped, so either one alone already discloses
 * the other — this is a wire-format choice, not a security difference.
 *
 * Reuses `resolvePublicShare` (session-public-shares.ts) for the exact same
 * 404 (unknown) / 410 (revoked or expired) / 503 (sandbox not provisioned
 * yet) semantics SESS-13 already covers — ANY valid share for a session
 * (created for a `preview` or a `file`, the only two kinds the CRUD routes
 * support today) unlocks the transcript view here too. A share token is
 * proof the session's owner handed this link to someone outside the account;
 * once handed out, viewing the read-only conversation is not more sensitive
 * than the live interactive preview or arbitrary workspace file the SAME
 * token already grants.
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
  return resolvePublicShare(publicShareToken(shareId));
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
      ...errors(400, 404, 410, 503),
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
      ...errors(400, 404, 410, 503),
    },
  }),
  async (c: any) => {
    const shareId = c.req.param('shareId');
    const resolved = await resolveShareId(shareId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);
    if (!resolved.row.externalId) {
      return c.json({ error: 'Sandbox is not ready' }, 503);
    }

    const result = await getPublicSessionMessages({
      sessionId: resolved.row.sessionId,
      externalId: resolved.row.externalId,
      sandboxStatus: resolved.row.sandboxStatus,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as any);
    return c.json(result.transcript);
  },
);

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
 * `:shareId` is either the share's raw `share_id` (the uuid primary key on
 * `project_session_public_shares`, what the CRUD routes call `share_id`) or
 * its `kps_...` public token (what `/v1/p/public-share/:token` and the web
 * viewer at `public_path: /share/session/:token` are keyed by). The two are
 * equally sensitive: a token IS `kps_` + the id with dashes stripped, so
 * either one alone already discloses the other. Accepting both is a
 * wire-format convenience, not a security difference.
 *
 * Reuses `resolvePublicShare` (session-public-shares.ts) for the exact same
 * 404 (unknown) / 410 (revoked, expired, or session deleted) semantics SESS-13
 * covers. A `preview` or `file` share whose sandbox has no `externalId` yet
 * still 503s there; a `transcript` share never needs a sandbox, and
 * `/messages` 503s only when no sandbox runs AND no transcript was saved.
 *
 * A share grants exactly the resource it names. A `file` share names one
 * document, and the proxies pin it to that path; a `preview` share names one
 * app port. Neither names the conversation, which carries prompts, pasted
 * values, and tool output the owner never chose to publish. So `/messages`
 * answers only for a `transcript` share (`shareUnlocksTranscript`), minted by
 * the CRUD route with `{ transcript: true }`; every `preview` and `file` share
 * gets `404`. `GET /:shareId` still returns the share and the session title,
 * which the share page shows beside the shared resource.
 *
 * A transcript share needs no running sandbox: `/messages` reads the live
 * conversation when the box is up and the saved transcript mirror otherwise
 * (`source: 'live' | 'mirror'`).
 */

import { createRoute, z } from '@hono/zod-openapi';
import { errors, json, makeOpenApiApp } from '../openapi';
import { createPublicSessionShareRateLimitMiddleware } from '../shared/rate-limit';
import {
  publicShareToken,
  resolvePublicShare,
  shareIdFromPublicRef,
} from '../shared/session-public-shares';
import { getPublicSessionInfo, getPublicSessionMessages } from '../shared/public-session-share-view';

export const publicSessionSharesApp = makeOpenApiApp();

publicSessionSharesApp.use('/:shareId', createPublicSessionShareRateLimitMiddleware());
publicSessionSharesApp.use('/:shareId/messages', createPublicSessionShareRateLimitMiddleware());

const ShareParams = z.object({ shareId: z.string() });

async function resolveShareId(ref: string, opts: { requireTranscript?: boolean } = {}) {
  const shareId = shareIdFromPublicRef(ref);
  if (!shareId) {
    return { ok: false as const, status: 400, error: 'Invalid share id' };
  }
  return resolvePublicShare(publicShareToken(shareId), opts);
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
    const resolved = await resolveShareId(shareId, { requireTranscript: true });
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);

    const result = await getPublicSessionMessages({
      sessionId: resolved.row.sessionId,
      externalId: resolved.row.externalId,
      sandboxStatus: resolved.row.sandboxStatus,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as any);
    return c.json(result.transcript);
  },
);

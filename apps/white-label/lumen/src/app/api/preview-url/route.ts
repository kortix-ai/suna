/**
 * Resolve one session preview URL on the server.
 *
 * The URL reaches the browser, so it must not carry a Kortix token: any
 * project-scoped token works on the whole Kortix API, past the Lumen proxy.
 * The route mints a Kortix public preview share instead. A share opens one
 * port of one session's sandbox and nothing else, and it expires after
 * PREVIEW_SHARE_TTL_MS. Kortix refuses shares of the runtime ports (8000 and
 * the harness ports), so a preview never reaches the session daemon. A live
 * share of the same port and path with more than 5 minutes left is reused.
 */

import { memberKortix, resolveMemberForSession } from '@/server/member';
import { type PreviewRequest, parsePreviewRequest } from '@/server/preview-request';
import { upstreamBase } from '@/server/upstream-path';
import { ApiError } from '@kortix/sdk';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PREVIEW_SHARE_TTL_MS = 15 * 60_000;
const REUSE_MARGIN_MS = 5 * 60_000;

function errorResponse(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  let body: PreviewRequest;
  try {
    body = (await req.json()) as PreviewRequest;
  } catch {
    return errorResponse(400, 'Invalid request body');
  }

  const input = parsePreviewRequest(body);
  if (!input) return errorResponse(400, 'Invalid preview request');

  const resolved = await resolveMemberForSession(req, input.projectId, input.sessionId);
  if ('error' in resolved) return resolved.error;
  const session = memberKortix(resolved.member).session(input.projectId, input.sessionId);

  try {
    await session.ensureReady();
    // Reuse a live share of the same port and path, so reopening the tab does
    // not add a share to the session's list each time.
    const label = `Lumen preview :${input.port}`;
    const { shares } = await session.publicShares.list();
    const live = shares.find(
      (s) =>
        s.label === label &&
        s.port === input.port &&
        s.path === input.path &&
        !s.revoked_at &&
        s.expires_at !== null &&
        Date.parse(s.expires_at) - Date.now() > REUSE_MARGIN_MS,
    );
    const share =
      live ??
      (
        await session.publicShares.create({
          preview: { port: input.port, path: input.path },
          mode: 'interactive',
          label,
          expires_at: new Date(Date.now() + PREVIEW_SHARE_TTL_MS).toISOString(),
        })
      ).share;
    // `public_url` is the sandbox's own preview origin. A deployment without
    // preview domains serves the share on the API origin (`proxy_path`).
    // Not resolvePublicShareUrl(): it falls back to `public_path`, the
    // transcript viewer, which is wrong for a preview share.
    const url = share.public_url ?? (share.proxy_path ? new URL(share.proxy_path, upstreamBase()).toString() : null);
    if (!url) return errorResponse(502, 'Could not resolve preview URL');
    return Response.json({ url });
  } catch (error) {
    const status = error instanceof ApiError && error.status ? error.status : 502;
    // A Kortix 400 names the refused port ("Preview cannot be shared on this port"); other errors stay generic.
    const message = status === 400 && error instanceof Error ? error.message : 'Could not resolve preview URL';
    return errorResponse(status, message);
  }
}

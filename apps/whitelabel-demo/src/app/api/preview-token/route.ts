/**
 * Mint a short-lived, PROJECT-SCOPED Kortix PAT for the preview iframe.
 *
 * Why this exists: a Next.js route handler can't proxy a WebSocket upgrade,
 * so the generic `/api/kortix/*` proxy can't carry a live dev server's HMR
 * socket (or anything else the sandbox serves over `ws://`). Instead, the
 * preview panel (in wrapper mode) opens the sandbox preview URL DIRECTLY
 * against `KORTIX_UPSTREAM`, authenticated with a token minted here —
 * `POST {upstream}/projects/:id/cli-token` using the operator's own
 * `KORTIX_API_KEY` — scoped to exactly the one project the caller owns.
 *
 * Ownership is checked BEFORE minting: a wrapper end user can only ever get a
 * token scoped to a project `isOwner()` confirms is theirs.
 *
 * Known tradeoff (documented, not silently ignored): this demo does not track
 * or revoke the minted `token_id`. A production wrapper should persist it and
 * `DELETE /projects/:id/cli-token/:tokenId` once the preview session ends (or
 * on a rotation schedule), so short-lived preview credentials don't
 * accumulate indefinitely on the account.
 */

import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isOwner, isValidProjectId } from '@/server/users';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function upstreamBase(): string {
  return (process.env.KORTIX_UPSTREAM ?? 'https://api.kortix.com/v1').replace(/\/+$/, '');
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Wrapper mode is not enabled on this server.' }, { status: 500 });
  }

  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });

  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId || !isValidProjectId(projectId)) {
    return Response.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (!isOwner(session.userId, projectId)) {
    return Response.json({ error: "You don't have access to this project." }, { status: 403 });
  }

  const upstream = upstreamBase();
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${upstream}/projects/${encodeURIComponent(projectId)}/cli-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `lumen-preview-${Date.now()}` }),
    });
  } catch {
    return Response.json({ error: 'Could not reach the Kortix API' }, { status: 502 });
  }

  const body = await upstreamRes.json().catch(() => null);
  if (!upstreamRes.ok || !body?.secret_key) {
    const message =
      typeof body?.message === 'string'
        ? body.message
        : typeof body?.error === 'string'
          ? body.error
          : 'Could not mint a preview token';
    return Response.json({ error: message }, { status: upstreamRes.status || 502 });
  }

  return Response.json({ token: body.secret_key as string, upstream, tokenId: body.token_id });
}

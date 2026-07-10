/**
 * Mint a short-lived, PROJECT-SCOPED Kortix PAT for the preview iframe.
 *
 * Why this exists: a Next.js route handler can't proxy a WebSocket upgrade,
 * so the generic `/api/kortix/*` proxy can't carry a live dev server's HMR
 * socket (or anything else the sandbox serves over `ws://`). Instead, the
 * preview panel (in wrapper mode) opens the sandbox preview URL DIRECTLY
 * against `KORTIX_UPSTREAM`, authenticated with a token minted here — via the
 * SDK's `kortix.project(id).tokens.create()` (`POST {upstream}/projects/:id/cli-token`)
 * using the operator's own `KORTIX_API_KEY` — scoped to exactly the one
 * project the caller owns. `createScopedKortix` (`@kortix/sdk/server`) is
 * used instead of the shared `configureKortix()` singleton because this route
 * serves concurrent requests carrying different end users' identities on one
 * process — each call gets its own isolated config via `AsyncLocalStorage`.
 *
 * Ownership is checked BEFORE minting: a wrapper end user can only ever get a
 * token scoped to a project `isOwner()` confirms is theirs.
 *
 * Known tradeoff (documented, not silently ignored): this demo does not track
 * or revoke the minted `token_id`. A production wrapper should persist it and
 * call `kortix.project(id).tokens.revoke(tokenId)` once the preview session
 * ends (or on a rotation schedule), so short-lived preview credentials don't
 * accumulate indefinitely on the account.
 */

import { ApiError } from '@kortix/sdk';
import { createScopedKortix } from '@kortix/sdk/server';
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
  const kortix = createScopedKortix({ backendUrl: upstream, getToken: async () => apiKey });

  let created: { secret_key: string; token_id: string };
  try {
    created = await kortix.project(projectId).tokens.create({ name: `lumen-preview-${Date.now()}` });
  } catch (err) {
    const status = err instanceof ApiError && err.status ? err.status : 502;
    const message = err instanceof Error ? err.message : 'Could not mint a preview token';
    return Response.json({ error: message }, { status });
  }

  return Response.json({ token: created.secret_key, upstream, tokenId: created.token_id });
}

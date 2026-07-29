/**
 * Re-scope a RUNNING session: which secrets it may read, which connections it
 * uses. SET semantics — the lists sent REPLACE the previous ones.
 *
 * A BFF route rather than a direct client call for the same reason as
 * `/api/session-model`: ownership is checked server-side before any id reaches an
 * upstream path, and the wrapper's key never goes near the browser.
 *
 * The response deliberately carries `retroactive` and `detail` through
 * unmodified. Dropping a secret stops it being DELIVERED from the next prompt;
 * it cannot un-read what the agent already has in its context or in shells it
 * already started. A UI that flattened that into "revoked" would be false
 * assurance, which is how a live credential gets left in place.
 */
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isOwner, isValidProjectId } from '@/server/users';
import { createScopedKortix } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function upstreamBase(): string {
  return (
    process.env.KORTIX_UPSTREAM ??
    process.env.KORTIX_API_URL ??
    'https://api.kortix.com/v1'
  ).replace(/\/+$/, '');
}

export async function PUT(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) return Response.json({ error: 'Wrapper mode is off' }, { status: 500 });

  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) return Response.json({ error: 'Rate limited' }, { status: 429 });

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const sessionId = url.searchParams.get('sessionId') ?? '';
  if (!isValidProjectId(projectId) || !UUID.test(sessionId)) {
    return Response.json({ error: 'Invalid identifiers' }, { status: 400 });
  }
  if (!isOwner(session.userId, projectId)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as {
    secrets?: unknown;
    bindings?: unknown;
  } | null;

  const payload: Record<string, unknown> = {};
  // `null` (stop narrowing) and `[]` (no project secrets) are OPPOSITE and both
  // meaningful, so the key is forwarded only when the caller actually sent it —
  // an absent key must not be turned into either one.
  if (body && 'secrets' in body) {
    payload.secrets = body.secrets === null ? null : (body.secrets as string[]);
  }
  if (body && 'bindings' in body && body.bindings && typeof body.bindings === 'object') {
    payload.connector_bindings = Object.fromEntries(
      Object.entries(body.bindings as Record<string, string>).map(([alias, profileId]) => [
        alias,
        { profile_id: profileId },
      ]),
    );
  }
  if (Object.keys(payload).length === 0) {
    return Response.json({ error: 'Nothing to re-scope' }, { status: 400 });
  }

  const kortix = createScopedKortix({ backendUrl: upstreamBase(), getToken: async () => apiKey });
  try {
    const result = await kortix.session(projectId, sessionId).rescope(payload);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not re-scope this session';
    return Response.json({ error: message }, { status: 400 });
  }
}

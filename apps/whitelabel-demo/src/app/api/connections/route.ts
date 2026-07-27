/**
 * Connections this wrapper may bind to a new session.
 *
 * Provider-neutral and pre-filtered: a wrapper can only bind TEAM connections
 * (see `selectBindableConnections`), so the client is never shown an option that
 * would fail at session create.
 */
import { selectBindableConnections } from '@/server/bindable-connections';
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isOwner, isValidProjectId } from '@/server/users';
import { createScopedKortix } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) return Response.json({ connections: [] });

  const session = getRequestSession(req);
  if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok) return Response.json({ error: 'Rate limited' }, { status: 429 });

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const connector = url.searchParams.get('connector') ?? '';
  if (!isValidProjectId(projectId) || !connector) {
    return Response.json({ error: 'Invalid identifiers' }, { status: 400 });
  }
  if (!isOwner(session.userId, projectId)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const kortix = createScopedKortix({
    backendUrl: process.env.KORTIX_API_URL ?? 'https://api.kortix.com/v1',
    getToken: async () => apiKey,
  });

  try {
    const result = await kortix.project(projectId).connectors.profiles.list();
    return Response.json({
      connections: selectBindableConnections(result?.profiles, connector),
    });
  } catch {
    // A project with no connectors is the common case, not an error state.
    return Response.json({ connections: [] });
  }
}

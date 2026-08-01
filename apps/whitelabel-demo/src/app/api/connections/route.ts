/**
 * Connections this wrapper may bind to a new session, grouped by connector
 * alias.
 *
 * Provider-neutral and pre-filtered: a wrapper can only bind project connections
 * (see `selectBindableConnections`), so the client is never shown an option that
 * would fail at session create. Aliases with NOTHING bindable are still
 * returned, carrying the reason — the client has to be able to say "a teammate
 * has to share this one" instead of pretending the connector doesn't exist.
 *
 * The alias was hardcoded to one connector when this route only served the
 * first-session screen. It is a request parameter now, and optional: a caller
 * that doesn't know which connectors a project has (the new-session dialog)
 * asks for all of them.
 */
import { selectConnectorBindingChoices } from '@/server/bindable-connections';
import { getRequestSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import { isOwner, isValidProjectId } from '@/server/users';
import { createScopedKortix } from '@kortix/sdk/server';
import type { NextRequest } from 'next/server';

function upstreamBase(): string {
  return (
    process.env.KORTIX_UPSTREAM ??
    process.env.KORTIX_API_URL ??
    'https://api.kortix.com/v1'
  ).replace(/\/+$/, '');
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.KORTIX_API_KEY;
  if (!apiKey) return Response.json({ connectors: [] });

  const session = getRequestSession(req);
  if (!session)
    return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const limited = consumeRateLimit(session.userId);
  if (!limited.ok)
    return Response.json({ error: 'Rate limited' }, { status: 429 });

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const connector = url.searchParams.get('connector') ?? '';
  if (!isValidProjectId(projectId)) {
    return Response.json({ error: 'Invalid identifiers' }, { status: 400 });
  }
  if (!isOwner(session.userId, projectId)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const kortix = createScopedKortix({
    // KORTIX_UPSTREAM first, like the proxy and every other server route: a
    // deployment that only sets it (the documented setup) was silently sending
    // this lookup to the PUBLIC api, whose failure this route swallows as "no
    // connections" — an empty picker with no error anywhere.
    backendUrl: upstreamBase(),
    getToken: async () => apiKey,
  });

  try {
    const result = await kortix
      .project(projectId)
      .connectors.authorizations.list();
    const connectors = selectConnectorBindingChoices(result?.profiles).filter(
      (choice) => !connector || choice.alias === connector,
    );
    return Response.json({ connectors });
  } catch {
    // A project with no connectors is the common case, not an error state.
    return Response.json({ connectors: [] });
  }
}

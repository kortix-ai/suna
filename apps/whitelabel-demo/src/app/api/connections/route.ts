/**
 * Connections a Lumen member may bind to a new session, grouped by connector
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
 * that doesn't know which connectors a project has asks for all of them.
 */
import { selectConnectorBindingChoices } from '@/server/bindable-connections';
import { memberKortix, resolveMemberFor } from '@/server/member';
import type { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const connector = url.searchParams.get('connector') ?? '';
  const resolved = await resolveMemberFor(req, projectId);
  if ('error' in resolved) return resolved.error;
  const kortix = memberKortix(resolved.member);

  try {
    const result = await kortix.project(projectId).connectors.connections.list();
    const connectors = selectConnectorBindingChoices(result.connections).filter(
      (choice) => !connector || choice.alias === connector,
    );
    return Response.json({ connectors });
  } catch {
    // A project with no connectors is the common case, not an error state.
    return Response.json({ connectors: [] });
  }
}

'use client';

import { useParams } from 'next/navigation';

/**
 * The real, routable URL for a session.
 *
 * The tab system historically wrote `/sessions/<id>` into the address bar via
 * `openTabAndNavigate`. That is not a route — it is a leftover of the
 * instance-scoped scheme in `INSTANCE_SCOPED_ROUTES`
 * (packages/sdk/src/core/http/instance-routes.ts), most of whose 19 paths no
 * longer have an App Router page. Because the tab stays mounted, the click
 * appears to work; the URL only betrays itself on reload or Back, which land on
 * a 404.
 *
 * Every caller sits inside `/projects/[id]/...`, so the project id is always
 * available from the route. Build the honest URL and the address bar, Back,
 * reload, and "copy link" all agree with what is on screen.
 */
export function projectSessionHref(projectId: string, sessionId: string): string {
  return `/projects/${projectId}/sessions/${sessionId}`;
}

/**
 * `projectSessionHref` bound to the project of the current route.
 *
 * Returns null off a project route — callers keep whatever fallback they had
 * rather than fabricating an id.
 */
export function useProjectSessionHref(): (sessionId: string) => string | null {
  const params = useParams<{ id?: string }>();
  const projectId = params?.id;
  return (sessionId: string) => (projectId ? projectSessionHref(projectId, sessionId) : null);
}

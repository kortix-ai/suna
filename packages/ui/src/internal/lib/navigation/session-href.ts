'use client';

import { uiRoutes } from '../../../lib/routes';
import { useSessionIds } from '../../../providers/session-ids';
import { MESSAGE_LINK_AT_PARAM, MESSAGE_LINK_PARAM } from './message-link';
import { RUNTIME_SESSION_PARAM } from './session-spawn-urls';

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
 * Every caller sits inside `/workspaces/[id]/...`, so the project id is always
 * available from the route. Build the honest URL and the address bar, Back,
 * reload, and "copy link" all agree with what is on screen.
 */
export function projectSessionHref(projectId: string, sessionId: string): string {
  return uiRoutes().session(projectId, sessionId);
}

/**
 * A session's URL opened at one message: `rs` selects the sub-thread that
 * holds it, `m` names the message, `at` (epoch ms) names the instant the
 * session page falls back to when the message is not in the thread. Empty
 * parts are left out, so a target with none of them is the session's URL.
 */
export function projectSessionMessageHref(
  projectId: string,
  sessionId: string,
  target: { messageId?: string | null; at?: number | null; threadId?: string | null },
): string {
  const params = new URLSearchParams();
  if (target.threadId) params.set(RUNTIME_SESSION_PARAM, target.threadId);
  if (target.messageId) params.set(MESSAGE_LINK_PARAM, target.messageId);
  if (target.at != null && Number.isFinite(target.at)) params.set(MESSAGE_LINK_AT_PARAM, String(Math.trunc(target.at)));
  const qs = params.toString();
  const href = projectSessionHref(projectId, sessionId);
  return qs ? `${href}${href.includes('?') ? '&' : '?'}${qs}` : href;
}

/**
 * `projectSessionHref` bound to the project of the current route.
 *
 * Returns null off a project route — callers keep whatever fallback they had
 * rather than fabricating an id.
 */
export function useProjectSessionHref(): (sessionId: string) => string | null {
  const projectId = useSessionIds().projectId;
  return (sessionId: string) => (projectId ? projectSessionHref(projectId, sessionId) : null);
}

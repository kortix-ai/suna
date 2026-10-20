import { uiRoutes } from '../../../lib/routes';
/**
 * The query parameter that opens a child runtime session inside a project
 * session route. Links written before W4 name it `oc`; readers still accept it.
 */
export const RUNTIME_SESSION_PARAM = 'rs';
const PRE_W4_RUNTIME_SESSION_PARAM = 'oc';

/** The child runtime session a URL asks for, under its neutral or its pre-W4 name. */
export function readRuntimeSessionParam(params: Pick<URLSearchParams, 'get'>): string | null {
  return params.get(RUNTIME_SESSION_PARAM) ?? params.get(PRE_W4_RUNTIME_SESSION_PARAM);
}

/** Remove the child runtime session from `params`, under both names. */
export function deleteRuntimeSessionParam(params: URLSearchParams): void {
  params.delete(RUNTIME_SESSION_PARAM);
  params.delete(PRE_W4_RUNTIME_SESSION_PARAM);
}

/** `href` (a project session route) opened on the child runtime session `childSessionId`. */
export function childSessionHref(href: string, childSessionId: string): string {
  return `${href}${href.includes('?') ? '&' : '?'}${RUNTIME_SESSION_PARAM}=${encodeURIComponent(childSessionId)}`;
}

/** The open session's URL with a child runtime session selected; null outside a session. */
export function projectChildSessionHref(
  ids: { projectId?: string; sessionId?: string },
  childSessionId: string | undefined,
) {
  if (!ids.projectId || !ids.sessionId || !childSessionId) return null;
  return childSessionHref(uiRoutes().session(ids.projectId, ids.sessionId), childSessionId);
}

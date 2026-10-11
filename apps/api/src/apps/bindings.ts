/**
 * The bindings mount: on an App's host, `/_kortix/apps/<slug>/*` reaches the
 * endpoint of an App it uses (`app_links`), HTTP and WebSocket, with the
 * prefix stripped. Code in the App needs one origin and no CORS:
 *
 *   const { url, token } = await kortixBinding('db');
 *   // url = location.origin + '/_kortix/apps/db'; token from /_kortix/token?audience=db
 *   const client = new ConvexClient(url); client.setAuth(() => token);
 *
 * The request passed the using App's access gate first. An App it does not use
 * answers 403 `app_not_linked`; a used App whose kind has no endpoint
 * (../kinds `endpoint`) answers 409 `app_binding_unsupported`. Convex: the
 * client API port; Convex keeps path prefixes in its client URLs. URLs Convex
 * itself generates (file storage) still name the App's own host.
 */
import { appNotLinkedResponse } from './public-proxy-access';
import { type AppKindEndpoint, appKindModule } from './kinds';
import { linkedApp } from './links';
import type { PreviewWsData } from '../sandbox-proxy/ws-proxy';

export const APP_BINDING_PREFIX = '/_kortix/apps/';

/** `/_kortix/apps/<slug>[/rest]` → the slug and the upstream path (`/` when none); null for any other path. */
export function parseBindingPath(pathname: string): { name: string; path: string } | null {
  if (!pathname.startsWith(APP_BINDING_PREFIX)) return null;
  const rest = pathname.slice(APP_BINDING_PREFIX.length);
  const slash = rest.indexOf('/');
  let name: string;
  try {
    name = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
  } catch {
    return null;
  }
  if (!name) return null;
  return { name, path: slash === -1 ? '/' : rest.slice(slash) };
}

type BindingApp = { appId: string; projectId: string };

/** The used App's endpoint, or the refusal to answer. */
async function boundEndpoint(app: BindingApp, name: string): Promise<{ endpoint: AppKindEndpoint; appId: string } | Response> {
  const linked = await linkedApp(app.appId, app.projectId, name);
  if (!linked) return appNotLinkedResponse(name);
  const endpoint = appKindModule(linked.kind).endpoint;
  if (!endpoint) {
    return Response.json(
      { error: `The App "${name}" has no endpoint to bind.`, code: 'app_binding_unsupported', kind: linked.kind },
      { status: 409, headers: { 'cache-control': 'no-store' } },
    );
  }
  return { endpoint, appId: linked.appId };
}

/** HTTP on the bindings mount. The caller ran the App gate. */
export async function appBindingResponse(request: Request, url: URL, publicHost: string, app: BindingApp): Promise<Response> {
  const parsed = parseBindingPath(url.pathname);
  if (!parsed) return Response.json({ error: 'Not found' }, { status: 404 });
  const bound = await boundEndpoint(app, parsed.name);
  if (bound instanceof Response) return bound;
  return bound.endpoint.fetch(request, bound.appId, `${parsed.path}${url.search}`, publicHost);
}

/** A WebSocket upgrade on the bindings mount: the upstream to pipe to. The caller ran the App gate. */
export async function appBindingWsUpgrade(
  request: Request,
  url: URL,
  publicHost: string,
  app: BindingApp,
): Promise<{ ok: true; data: PreviewWsData } | { ok: false; status: number; message: string }> {
  const parsed = parseBindingPath(url.pathname);
  if (!parsed) return { ok: false, status: 404, message: 'Not found' };
  const bound = await boundEndpoint(app, parsed.name);
  if (bound instanceof Response) {
    const body = (await bound.json()) as { error: string };
    return { ok: false, status: bound.status, message: body.error };
  }
  return bound.endpoint.websocket(request, bound.appId, `${parsed.path}${url.search}`, publicHost);
}

/**
 * The bindings mount: on an App's host, `/_kortix/apps/<slug>/*` reaches the
 * `http` service of an App it uses (`app_links`) and `/_kortix/apps/<slug>--<service>/*`
 * another of its services, HTTP and WebSocket, with the prefix stripped. A
 * service with `access: admins` is never bound (403 `app_binding_forbidden`). Code in the App needs one origin and no CORS:
 *
 *   const { url, token } = await kortixBinding('db');
 *   // url = location.origin + '/_kortix/apps/db'; token from /_kortix/token?audience=db
 *
 * The request passed the using App's access gate first. An App it does not use
 * answers 403 `app_not_linked`; a used App that runs no server (a static App)
 * answers 409 `app_binding_unsupported`; one with no live runtime answers 503
 * `app_binding_unavailable`. The used App authenticates the caller itself (the
 * token), as it does for any public request.
 */
import { appNotLinkedResponse } from './public-proxy-access';
import { linkedApp } from './links';
import { AppHostingProvider } from './hosting';
import { proxyRunningApp } from './public-proxy-handler';
import { appRuntimeNeedsWake, appUpstreamHeaders, ensureAppRuntimeRunning, loadPublicAppState } from './public-proxy';
import { type AppWsData, stampActivity, websocketUrl } from './ws-proxy';
import { ingressTargetUrl } from '../platform/providers/ingress-url';
import type { SandboxProviderName } from '../config';
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

type PublicState = NonNullable<Awaited<ReturnType<typeof loadPublicAppState>>>;
type BoundApp = { app: PublicState['app']; deployment: NonNullable<PublicState['deployment']>; runtime: NonNullable<PublicState['runtime']>; servicePort?: number };

const refusal = (status: number, code: string, error: string) =>
  Response.json({ error, code }, { status, headers: { 'cache-control': 'no-store' } });

/** The used App with a live runtime, or the refusal to answer. */
async function boundApp(app: BindingApp, binding: string): Promise<BoundApp | Response> {
  const [name, service = 'http'] = binding.split('--', 2) as [string, string?];
  const linked = await linkedApp(app.appId, app.projectId, name);
  if (!linked) return appNotLinkedResponse(name);
  const state = await loadPublicAppState(linked.routeKey, service);
  if (!state) return refusal(404, 'app_not_found', `The App "${name}" does not exist.`);
  if (service !== 'http' && !state.service) {
    return refusal(404, 'app_service_not_found', `The App "${name}" has no service "${service}".`);
  }
  if (state.service?.access === 'admins') {
    return refusal(403, 'app_binding_forbidden', `The service "${service}" of "${name}" is for project admins only.`);
  }
  if (state.deployment?.hostingType === 'static') {
    return refusal(409, 'app_binding_unsupported', `The App "${name}" is static: it runs no server to bind.`);
  }
  if (
    !state.app.activeDeploymentId ||
    state.deployment?.deploymentId !== state.app.activeDeploymentId ||
    state.deployment.status !== 'ready' ||
    !state.runtime
  ) {
    return refusal(503, 'app_binding_unavailable', `The App "${name}" has no running release.`);
  }
  return {
    app: state.app, deployment: state.deployment, runtime: state.runtime,
    ...(service !== 'http' && state.service ? { servicePort: state.service.internal_port } : {}),
  };
}

/** HTTP on the bindings mount. The caller ran the App gate. */
export async function appBindingResponse(request: Request, url: URL, publicHost: string, app: BindingApp): Promise<Response> {
  const parsed = parseBindingPath(url.pathname);
  if (!parsed) return Response.json({ error: 'Not found' }, { status: 404 });
  const bound = await boundApp(app, parsed.name);
  if (bound instanceof Response) return bound;
  const upstreamUrl = new URL(`${parsed.path}${url.search}`, url.origin);
  const coldStart = appRuntimeNeedsWake(bound.runtime, new Date(), bound.app.alwaysOn);
  return proxyRunningApp(request, upstreamUrl, publicHost, null, bound, new AppHostingProvider(), coldStart, bound.servicePort);
}

/** A WebSocket upgrade on the bindings mount: the upstream to pipe to. The caller ran the App gate. */
export async function appBindingWsUpgrade(
  request: Request,
  url: URL,
  publicHost: string,
  app: BindingApp,
): Promise<{ ok: true; data: AppWsData | PreviewWsData } | { ok: false; status: number; message: string }> {
  const parsed = parseBindingPath(url.pathname);
  if (!parsed) return { ok: false, status: 404, message: 'Not found' };
  const bound = await boundApp(app, parsed.name);
  if (bound instanceof Response) {
    const body = (await bound.json()) as { error: string };
    return { ok: false, status: bound.status, message: body.error };
  }
  try {
    const hosting = new AppHostingProvider();
    const runtime = await ensureAppRuntimeRunning(bound, hosting);
    await stampActivity(runtime.runtimeId, bound.app.idleTimeoutSeconds);
    const ingress = await hosting.ingress(runtime.provider as SandboxProviderName, runtime.externalId, 'websocket', bound.servicePort);
    return {
      ok: true,
      data: {
        type: 'app-ws',
        url: websocketUrl(ingressTargetUrl(ingress, `${parsed.path}${url.search}`)),
        headers: Object.fromEntries(appUpstreamHeaders(request, ingress.headers, publicHost).entries()),
        runtimeId: runtime.runtimeId,
        idleTimeoutSeconds: bound.app.idleTimeoutSeconds,
      },
    };
  } catch {
    return { ok: false, status: 202, message: 'App is starting' };
  }
}

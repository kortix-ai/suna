/**
 * App kinds. Every App has one `kind`, fixed at create. The App core (routes,
 * access, budget fields, deletion) is the same for every kind; a kind module
 * owns what differs: the capabilities it offers and its own maintenance pass.
 *
 *   web     a site or a server built from a deployment: static files served
 *           from storage, or a runtime sandbox that sleeps when idle (../*.ts).
 *   convex  a self-hosted Convex backend in its own always-on machine
 *           (./convex/). It never sleeps; its budget alerts and never stops it;
 *           a delete keeps the stopped machine and a `final` snapshot 7 days.
 *
 * Clients branch on `capabilities`, never on `kind`. A route that needs a
 * capability the App lacks answers 409 `app_capability_unsupported`.
 */
import { logger } from '../../lib/logger';
import type { PreviewWsData } from '../../sandbox-proxy/ws-proxy';
import { convexKind } from './convex';
import { webKind } from './web';

export const APP_KINDS = ['web', 'convex'] as const;
export type AppKind = (typeof APP_KINDS)[number];

export const APP_CAPABILITIES = [
  'deployments',
  'rollback',
  'preview',
  'sleep',
  'static',
  'snapshots',
  'restore',
  'admin_credentials',
  'dashboard',
  'logs',
  'member_tokens',
] as const;
export type AppCapability = (typeof APP_CAPABILITIES)[number];

/** How the active deployment is served: `sandbox` (a server), `static`, `convex`; null when never deployed. */
export type AppHostingType = 'sandbox' | 'static' | 'convex';

export interface AppKindModule {
  /** What an App of this kind supports now. `hostingType`: its active deployment's. */
  capabilities(hostingType: AppHostingType | null): AppCapability[];
  /** One pass of the kind's own lifecycle, from the project maintenance tick. Counters for its log line. */
  maintain?: () => Promise<Record<string, number>>;
  /**
   * The App's endpoint behind the bindings mount of an App that uses it
   * (`/_kortix/apps/<slug>/*`, ../bindings.ts): HTTP and WebSocket, prefix
   * already stripped. Absent: an App of this kind cannot be bound.
   */
  endpoint?: AppKindEndpoint;
}

export interface AppKindEndpoint {
  fetch(request: Request, appId: string, pathAndQuery: string, publicHost: string): Promise<Response>;
  websocket(
    request: Request,
    appId: string,
    pathAndQuery: string,
    publicHost: string,
  ): Promise<{ ok: true; data: PreviewWsData } | { ok: false; status: number; message: string }>;
}

export const APP_KIND_MODULES: Record<AppKind, AppKindModule> = { web: webKind, convex: convexKind };

export function appKindModule(kind: string): AppKindModule {
  return APP_KIND_MODULES[kind as AppKind] ?? webKind;
}

export function appCapabilities(app: { kind: string }, hostingType: AppHostingType | null): AppCapability[] {
  return appKindModule(app.kind).capabilities(hostingType);
}

/** The 409 body for a route whose capability this App lacks. */
export function capabilityUnsupportedBody(app: { kind: string }, capability: AppCapability) {
  return {
    error: `A ${app.kind} App does not support ${capability.replaceAll('_', ' ')}.`,
    code: 'app_capability_unsupported',
    capability,
    kind: app.kind,
  };
}

/**
 * Every kind's maintenance pass, one after the other. A failed pass logs and
 * counts `errors: 1`; it never stops the others or the tick.
 */
export async function maintainAppKinds(): Promise<Record<AppKind, Record<string, number>>> {
  const out = {} as Record<AppKind, Record<string, number>>;
  for (const kind of APP_KINDS) {
    const maintain = APP_KIND_MODULES[kind].maintain;
    out[kind] = maintain
      ? await maintain().catch((error) => {
          logger.warn('[apps] kind maintenance failed', { kind, error: String(error) });
          return { errors: 1 };
        })
      : {};
  }
  return out;
}

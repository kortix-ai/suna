/**
 * `/v1/workspaces`: the canonical HTTP names of the workspace (design §4).
 *
 * The workspace is one entity with two physical keys, so most of its routes
 * come from two existing apps, mounted again under the canonical prefix. The
 * workspace resource itself (`GET`/`POST /v1/workspaces`, `GET`/`PATCH
 * /v1/workspaces/:workspaceId`) has its own routes (`./routes.ts`).
 * The old mounts stay permanently (`/v1/projects`, `/v1/accounts`, …); the
 * name map lives in `@kortix/shared/workspace-routes`.
 *
 *   /v1/workspaces, /v1/workspaces/:workspaceId ← ./routes.ts (the workspace resource)
 *   /v1/workspaces/:workspaceId/…               ← projectsApp (and the token-issuer and app-events apps)
 *   /v1/workspaces/:workspaceId/<family>[/…]    ← the account-key families of accountsRouter
 *   /v1/me[/…]                                  ← accountsRouter `/me…`
 *   /v1/connectors/workspaces/:workspaceId/…    ← connectorApp `/projects/:workspaceId/…`
 *   /scim/v2/workspaces/:workspaceId/…          ← scimRouter `/accounts/:workspaceId/…`
 *
 * `aliasApp` copies the selected route entries of a source app into a new app,
 * exactly as Hono's own `app.route()` copies them: the same handler functions,
 * so an alias pair runs the same code (`unit-workspace-route-aliases.test.ts`).
 * It also copies their OpenAPI definitions so the spec lists the canonical name,
 * under the `workspaces` tag.
 *
 * Canonical paths take the workspace id only (`middleware/workspace-account.ts`):
 * an account id, an unknown id or an unreadable workspace answers
 * `404 workspace_not_found` on every sub-path.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  WORKSPACE_ACCOUNT_FAMILIES,
  WORKSPACE_LEGACY_ONLY_ROUTES,
  WORKSPACE_MERGED_LEGACY_ROUTES,
} from '@kortix/shared/workspace-routes';

import { canonicalWorkspaceGate } from '../middleware/workspace-account';
import { makeOpenApiApp } from '../openapi';

export { registerWorkspaceRootRoutes, workspacesRootApp } from './routes';

// biome-ignore lint/suspicious/noExplicitAny: Hono apps of every env shape are copied here.
type AnyApp = OpenAPIHono<any, any, any>;

interface RouteEntry {
  method: string;
  path: string;
  handler: (...args: unknown[]) => unknown;
}

interface RegistryDefinition {
  type: string;
  route?: { path: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface AliasOptions {
  /** Keep a source route, by its routing path inside the source app (`/:workspaceId/iam/groups`) and method. */
  include: (path: string, method: string) => boolean;
  /** The route's path inside the alias app. Default: unchanged. */
  rewrite?: (path: string) => string;
  /**
   * Where the source's catch-all middleware (`use('/*')`) runs in the alias
   * app. A catch-all would otherwise run for every request under the mount
   * prefix, including routes of another app mounted there.
   */
  middlewarePaths: readonly string[];
  /** Middleware added right after the source's catch-all middleware (auth), on these paths. */
  after?: { paths: readonly string[]; handler: (...args: unknown[]) => unknown };
  /** The OpenAPI tag of every copied operation. Default: the source's tags. */
  tag?: string;
}

const CATCH_ALL = new Set(['/*', '*']);
const openApiToRouting = (path: string) => path.replace(/\{([^}]+)\}/g, ':$1');
// Only a whole segment is a param: `/policies:bulk-delete` is a custom verb, not `{bulk}`.
const routingToOpenApi = (path: string) => path.replace(/(^|\/):([A-Za-z0-9_]+)/g, '$1{$2}');

/**
 * A copied operation's summary in workspace words: "List project secrets" →
 * "List workspace secrets", "Leave an account" → "Leave a workspace". A
 * qualified noun keeps its meaning: a service account, a Claude account, a
 * stored account or a connector's accounts are credentials, not the
 * workspace. Pure: exported for tests.
 */
export function canonicalSummary(summary: string): string {
  if (/^Accounts this principal/.test(summary)) return summary;
  return summary
    .replace(
      /(?<!(?:service|Claude|stored|new|email|own)[- ])\b(project|account|Project|Account)(s|'s|’s)?\b(?![-_])/g,
      (_m, noun: string, suffix: string | undefined) =>
        `${noun[0] === noun[0]!.toUpperCase() ? 'Workspace' : 'workspace'}${suffix ?? ''}`,
    )
    .replace(/\b(a|A)n (workspace)/g, '$1 $2')
    .replace(/\bper-project\b/g, 'per-workspace');
}

/** A new app holding the selected routes of `source`. Mount it with `app.route(prefix, …)`. */
export function aliasApp(source: AnyApp, opts: AliasOptions): AnyApp {
  const out = makeOpenApiApp<any>();
  // Keep the source's error handler, as Hono's own `app.route()` would.
  (out as unknown as { errorHandler: unknown }).errorHandler = (source as unknown as { errorHandler: unknown }).errorHandler;
  const rewrite = opts.rewrite ?? ((p: string) => p);
  const add = (method: string, path: string, handler: RouteEntry['handler']) =>
    (out as unknown as { on(m: string, p: string, h: unknown): void }).on(method, path, handler);

  let afterAdded = false;
  const addAfter = () => {
    if (afterAdded || !opts.after) return;
    afterAdded = true;
    for (const p of opts.after.paths) add('ALL', p, opts.after.handler as RouteEntry['handler']);
  };
  for (const r of (source as unknown as { routes: RouteEntry[] }).routes) {
    if (r.method === 'ALL' && CATCH_ALL.has(r.path)) {
      for (const p of opts.middlewarePaths) add('ALL', p, r.handler);
      continue;
    }
    // The first route entry ends the source's leading catch-all chain (auth).
    addAfter();
    if (opts.include(r.path, r.method)) add(r.method, rewrite(r.path), r.handler);
  }
  addAfter();

  // `openAPIRegistry.definitions` is a getter that returns a copy: register
  // through the registry's own methods. Schemas and components reach the
  // parent through the source app's own mount.
  const registry = (out as unknown as { openAPIRegistry: { registerPath(route: object): void } }).openAPIRegistry;
  const sourceDefs = (source as unknown as { openAPIRegistry: { definitions: RegistryDefinition[] } }).openAPIRegistry
    .definitions;
  for (const def of sourceDefs) {
    if (def.type !== 'route' || !def.route) continue;
    const routing = openApiToRouting(def.route.path);
    if (!opts.include(routing, String(def.route.method ?? '').toUpperCase())) continue;
    registry.registerPath({
      ...def.route,
      path: routingToOpenApi(rewrite(routing)),
      ...(opts.tag ? { tags: [opts.tag] } : {}),
      ...(opts.tag && typeof def.route.summary === 'string' ? { summary: canonicalSummary(def.route.summary) } : {}),
    });
  }
  return out;
}

/** `/:workspaceId/<family>` and everything under it, for every account family. */
const FAMILY_MIDDLEWARE_PATHS = WORKSPACE_ACCOUNT_FAMILIES.flatMap((family) => [
  `/:workspaceId/${family}`,
  `/:workspaceId/${family}/*`,
]);

function isFamilyRoute(path: string): boolean {
  const m = /^\/:workspaceId\/([^/]+)/.exec(path);
  return m !== null && (WORKSPACE_ACCOUNT_FAMILIES as readonly string[]).includes(m[1]!);
}

/** The account-key families of `accountsRouter`, for `/v1/workspaces`. */
export function workspaceAccountFamiliesApp(accountsRouter: AnyApp): AnyApp {
  return aliasApp(accountsRouter, { include: isFamilyRoute, middlewarePaths: FAMILY_MIDDLEWARE_PATHS, tag: 'workspaces' });
}

/**
 * The `projectsApp` routes `/v1/workspaces` does NOT serve (K3), as
 * `METHOD routing-path` inside `projectsApp`: the legacy routes of
 * `WORKSPACE_MERGED_LEGACY_ROUTES` (their canonical name is another route:
 * `./routes.ts`, or the workspace audit log of the account-key family) and of
 * `WORKSPACE_LEGACY_ONLY_ROUTES` (the account-scoped managed creates and the quota).
 */
export const WORKSPACE_PROJECT_ROUTES_NOT_ALIASED: ReadonlySet<string> = new Set(
  [...WORKSPACE_MERGED_LEGACY_ROUTES, ...WORKSPACE_LEGACY_ONLY_ROUTES]
    .map((route) => /^([A-Z]+) \/v1\/projects(\/.*)?$/.exec(route))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]} ${m[2] ?? '/'}`),
);

/**
 * The `projectsApp` routes whose canonical name has another tail, as
 * `routing-path` inside `projectsApp` → the path under `/v1/workspaces`: the
 * project audit slice, because `GET /v1/workspaces/:workspaceId/audit` is the
 * workspace audit log (`canonicalWorkspaceRoute` in `@kortix/shared`).
 */
export const WORKSPACE_PROJECT_ROUTE_RENAMES: Readonly<Record<string, string>> = {
  '/:workspaceId/audit': '/:workspaceId/audit/events',
};

/**
 * `projectsApp` for `/v1/workspaces`: every route, in the same order, except
 * {@link WORKSPACE_PROJECT_ROUTES_NOT_ALIASED}, with
 * {@link WORKSPACE_PROJECT_ROUTE_RENAMES} applied. After auth, the canonical gate
 * answers 404 `workspace_not_found` for an id that is not a readable
 * workspace and 409 `workspace_setup_required` for a workspace with no
 * project yet.
 */
export function workspaceProjectsApp(projectsApp: AnyApp): AnyApp {
  return aliasApp(projectsApp, {
    include: (p, method) => !WORKSPACE_PROJECT_ROUTES_NOT_ALIASED.has(`${method} ${p}`),
    rewrite: (p) => WORKSPACE_PROJECT_ROUTE_RENAMES[p] ?? p,
    middlewarePaths: ['/*'],
    after: { paths: ['/:workspaceId', '/:workspaceId/*'], handler: canonicalWorkspaceGate() as RouteEntry['handler'] },
    tag: 'workspaces',
  });
}

/** `accountsRouter`'s `/me…` routes, for `/v1` (`/v1/me`, `/v1/me/devices`). */
export function meApp(accountsRouter: AnyApp): AnyApp {
  return aliasApp(accountsRouter, {
    include: (p) => p === '/me' || p.startsWith('/me/'),
    middlewarePaths: ['/me', '/me/*'],
  });
}

/** `connectorApp`'s `/projects/:workspaceId/…` routes as `/workspaces/:workspaceId/…`, for `/v1/connectors`. */
export function connectorWorkspacesApp(connectorApp: AnyApp): AnyApp {
  return aliasApp(connectorApp, {
    include: (p) => p.startsWith('/projects/'),
    rewrite: (p) => `/workspaces/${p.slice('/projects/'.length)}`,
    middlewarePaths: ['/workspaces/*'],
  });
}

/**
 * `projectWebhooksApp`'s `/projects/:workspaceId/:slug` trigger fire as
 * `/workspaces/:workspaceId/:slug`, for `/v1/webhooks`. The URL Kortix shows
 * for a webhook trigger names the workspace path; the project path answers
 * permanently, so a sender configured before 2026-11-06 needs no change.
 */
export function webhookWorkspacesApp(projectWebhooksApp: AnyApp): AnyApp {
  return aliasApp(projectWebhooksApp, {
    include: (p) => p.startsWith('/projects/'),
    rewrite: (p) => `/workspaces/${p.slice('/projects/'.length)}`,
    middlewarePaths: [],
  });
}

/** `scimRouter`'s `/accounts/:workspaceId/…` routes as `/workspaces/:workspaceId/…`, for `/scim/v2`. */
export function scimWorkspacesApp(scimRouter: AnyApp): AnyApp {
  return aliasApp(scimRouter, {
    include: (p) => p.startsWith('/accounts/'),
    rewrite: (p) => `/workspaces/${p.slice('/accounts/'.length)}`,
    middlewarePaths: ['/workspaces/*'],
  });
}

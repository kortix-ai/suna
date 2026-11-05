/**
 * `/v1/workspaces`: the canonical HTTP names of the workspace (design §4).
 *
 * The workspace is one entity with two physical keys, so its routes come from
 * two existing apps, mounted again under the canonical prefix. Nothing here
 * has a handler of its own except the settings block of `GET /v1/workspaces/:workspaceId`.
 * The old mounts stay permanently (`/v1/projects`, `/v1/accounts`, …); the
 * name map lives in `@kortix/shared/workspace-routes`.
 *
 *   /v1/workspaces[/…]                          ← projectsApp (and the token-issuer and app-events apps)
 *   /v1/workspaces/:workspaceId/<family>[/…]    ← the account-key families of accountsRouter
 *   /v1/me[/…]                                  ← accountsRouter `/me…`
 *   /v1/connectors/workspaces/:workspaceId/…    ← connectorApp `/projects/:workspaceId/…`
 *   /scim/v2/workspaces/:workspaceId/…          ← scimRouter `/accounts/:workspaceId/…`
 *
 * `aliasApp` copies the selected route entries of a source app into a new app,
 * exactly as Hono's own `app.route()` copies them: the same handler functions,
 * so an alias pair runs the same code (`unit-workspace-route-aliases.test.ts`).
 * It also copies their OpenAPI definitions so the spec lists the canonical name.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { WORKSPACE_ACCOUNT_FAMILIES } from '@kortix/shared/workspace-routes';
import type { Context, MiddlewareHandler } from 'hono';

import { makeOpenApiApp } from '../openapi';
import { readWorkspaceSettings } from './settings';

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
}

const CATCH_ALL = new Set(['/*', '*']);
const openApiToRouting = (path: string) => path.replace(/\{([^}]+)\}/g, ':$1');
const routingToOpenApi = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** A new app holding the selected routes of `source`. Mount it with `app.route(prefix, …)`. */
export function aliasApp(source: AnyApp, opts: AliasOptions): AnyApp {
  const out = makeOpenApiApp<any>();
  // Keep the source's error handler, as Hono's own `app.route()` would.
  (out as unknown as { errorHandler: unknown }).errorHandler = (source as unknown as { errorHandler: unknown }).errorHandler;
  const rewrite = opts.rewrite ?? ((p: string) => p);
  const add = (method: string, path: string, handler: RouteEntry['handler']) =>
    (out as unknown as { on(m: string, p: string, h: unknown): void }).on(method, path, handler);

  for (const r of (source as unknown as { routes: RouteEntry[] }).routes) {
    if (r.method === 'ALL' && CATCH_ALL.has(r.path)) {
      for (const p of opts.middlewarePaths) add('ALL', p, r.handler);
      continue;
    }
    if (opts.include(r.path, r.method)) add(r.method, rewrite(r.path), r.handler);
  }

  const registry = (out as unknown as { openAPIRegistry: { definitions: RegistryDefinition[] } }).openAPIRegistry;
  for (const def of (source as unknown as { openAPIRegistry: { definitions: RegistryDefinition[] } }).openAPIRegistry
    .definitions) {
    if (def.type !== 'route' || !def.route) continue;
    const routing = openApiToRouting(def.route.path);
    if (!opts.include(routing, String(def.route.method ?? '').toUpperCase())) continue;
    registry.definitions.push({ ...def, route: { ...def.route, path: routingToOpenApi(rewrite(routing)) } });
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
  return aliasApp(accountsRouter, { include: isFamilyRoute, middlewarePaths: FAMILY_MIDDLEWARE_PATHS });
}

/**
 * `projectsApp` for `/v1/workspaces`: every route, in the same order, except
 * `GET /:workspaceId/audit`. The canonical audit route is the workspace audit
 * log (the account-key family, mounted first), so the project slice there
 * would only be a shadowed row. `/v1/projects/:workspaceId/audit` keeps it.
 */
export function workspaceProjectsApp(projectsApp: AnyApp): AnyApp {
  return aliasApp(projectsApp, {
    include: (p, method) => !(method === 'GET' && p === '/:workspaceId/audit'),
    middlewarePaths: ['/*'],
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

/** `scimRouter`'s `/accounts/:workspaceId/…` routes as `/workspaces/:workspaceId/…`, for `/scim/v2`. */
export function scimWorkspacesApp(scimRouter: AnyApp): AnyApp {
  return aliasApp(scimRouter, {
    include: (p) => p.startsWith('/accounts/'),
    rewrite: (p) => `/workspaces/${p.slice('/accounts/'.length)}`,
    middlewarePaths: ['/workspaces/*'],
  });
}

/**
 * `GET /v1/workspaces/:workspaceId` answers the project record (the
 * `/v1/projects/:projectId` handler) plus `workspace`: the settings the
 * account key holds. Mount on `/v1/workspaces/:workspaceId` before the project
 * app. Any other answer (403, 404) passes through untouched.
 */
export function workspaceDetailSettings(): MiddlewareHandler {
  return async (c: Context, next) => {
    await next();
    if (c.req.method !== 'GET' || c.res.status !== 200) return;
    if (!c.res.headers.get('content-type')?.includes('application/json')) return;
    const body = (await c.res.clone().json()) as Record<string, unknown> | null;
    const workspaceId = typeof body?.project_id === 'string' ? body.project_id : null;
    if (!body || !workspaceId) return;
    const settings = await readWorkspaceSettings(workspaceId);
    if (!settings) return;
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify({ ...body, workspace: settings }), { status: 200, headers });
  };
}

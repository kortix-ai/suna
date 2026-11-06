/**
 * `/v1/workspaces` is the canonical name of every workspace route; the old
 * names (`/v1/projects`, `/v1/accounts/:id/<family>`, `/v1/accounts/me`,
 * `/v1/account-invites`, `/v1/connectors/projects`, `/scim/v2/accounts`) stay
 * mounted permanently. The route manifest marks each old name with `aliasOf`.
 *
 * This file proves, on the live route table (`app.routes`):
 *   1. every `aliasOf` pair dispatches the SAME handler function, so an old
 *      and a new URL can never drift apart;
 *   2. every canonical route has its legacy alias, and every legacy route under
 *      an aliased prefix has its canonical twin, except the merged routes (the
 *      canonical name is another route), the legacy-only routes (no canonical
 *      name, K3) and the retired 410 routes;
 *   4. every route that names projects or accounts has a workspace name, or a
 *      written reason (the naming rule, below);
 *   3. the committed manifest's `aliasOf` rows are exactly what the name map
 *      in `@kortix/shared/workspace-routes` computes.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  canonicalWorkspaceRoute,
  legacyWorkspaceRoute,
  WORKSPACE_LEGACY_ONLY_ROUTES,
  WORKSPACE_LEGACY_REPLACEMENTS,
  WORKSPACE_MERGED_LEGACY_ROUTES,
  workspaceAliasOf,
} from '@kortix/shared/workspace-routes';

const { app } = await import('../index');
const { RETIRED_ROUTES } = await import('../routes/retired');

type Handler = ((...args: unknown[]) => unknown) & { [key: symbol]: unknown };
type RouteRow = { method: string; path: string; handler: Handler };

/** Endpoint handlers by `METHOD path`: `use()` middleware (arity ≥ 2 on `ALL`) is not an endpoint. */
const endpoints = new Map<string, Handler[]>();
for (const route of (app as unknown as { routes: RouteRow[] }).routes) {
  const method = route.method.toUpperCase();
  if (method === 'ALL' && route.handler.length >= 2) continue;
  // An openapi route registers its validators as handlers before the endpoint:
  // keep them all, in order. The last one is the endpoint.
  const key = `${method} ${route.path}`;
  endpoints.set(key, [...(endpoints.get(key) ?? []), route.handler]);
}

/** Hono wraps a sub-app handler when that app has its own error handler; compare the inner one. */
function unwrap(handler: Handler): unknown {
  for (const sym of Object.getOwnPropertySymbols(handler)) {
    if (sym.description === 'composedHandler') return unwrap(handler[sym] as Handler);
  }
  return handler;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../../../tests/spec/routes.generated.json', import.meta.url), 'utf8'),
) as { routes: Array<{ method: string; path: string; aliasOf?: string }> };

const ALIASED_PREFIX = /^(\/v1\/projects|\/v1\/accounts\/:workspaceId\/|\/v1\/accounts\/me|\/v1\/account-invites|\/v1\/connectors\/projects\/|\/scim\/v2\/accounts\/|\/v1\/webhooks\/projects\/)/;
const CANONICAL_PREFIX = /^(\/v1\/workspaces|\/v1\/me(\/|$)|\/v1\/invites|\/v1\/connectors\/workspaces\/|\/scim\/v2\/workspaces\/|\/v1\/webhooks\/workspaces\/)/;
const merged = new Set(WORKSPACE_MERGED_LEGACY_ROUTES);
const legacyOnly = new Set(WORKSPACE_LEGACY_ONLY_ROUTES);
const retired = new Set(RETIRED_ROUTES.map(([m, p]) => `${m} ${p}`));

describe('workspace route aliases', () => {
  const aliasRows = manifest.routes.filter((r) => r.aliasOf);

  test('the manifest lists the canonical workspace routes and their aliases', () => {
    expect(aliasRows.length).toBeGreaterThan(600);
    expect(manifest.routes.some((r) => r.path === '/v1/workspaces/:workspaceId/sessions')).toBe(true);
    expect(manifest.routes.some((r) => r.path === '/v1/workspaces/:workspaceId/iam/groups')).toBe(true);
  });

  test('every alias pair dispatches the same handler', () => {
    const different: string[] = [];
    for (const row of aliasRows) {
      const legacy = endpoints.get(`${row.method} ${row.path}`);
      const canonical = endpoints.get(`${row.method} ${row.aliasOf}`);
      if (!legacy || !canonical) {
        different.push(`${row.method} ${row.path}: ${legacy ? 'canonical' : 'legacy'} missing from app.routes`);
        continue;
      }
      const a = legacy.map(unwrap);
      const b = canonical.map(unwrap);
      if (a.length !== b.length || a.some((h, i) => h !== b[i])) {
        different.push(`${row.method} ${row.path} ≠ ${row.aliasOf}`);
      }
    }
    expect(different).toEqual([]);
  });

  test('every canonical route has a legacy alias, and every legacy route a canonical twin', () => {
    const aliased = new Set(aliasRows.map((r) => `${r.method} ${r.aliasOf}`));
    const canonicalWithoutAlias = manifest.routes
      .filter((r) => CANONICAL_PREFIX.test(r.path) && !aliased.has(`${r.method} ${r.path}`))
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => ![...merged].some((m) => `${m.split(' ')[0]} ${canonicalWorkspaceRoute(m.split(' ')[1]!)}` === key));
    expect(canonicalWithoutAlias).toEqual([]);

    const legacyWithoutCanonical = manifest.routes
      .filter((r) => ALIASED_PREFIX.test(r.path) && !r.aliasOf)
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !merged.has(key) && !legacyOnly.has(key) && !retired.has(key))
      // GET/PATCH /v1/accounts/:workspaceId: the account record, its own route.
      .filter((key) => !/^(GET|PATCH) \/v1\/accounts\/:workspaceId$/.test(key));
    expect(legacyWithoutCanonical).toEqual([]);
  });

  test('the committed aliasOf rows match the shared name map', () => {
    const keys = new Set(manifest.routes.map((r) => `${r.method} ${r.path}`));
    for (const row of manifest.routes) {
      const expected = workspaceAliasOf(row.method, row.path, (m, p) => keys.has(`${m} ${p}`)) ?? undefined;
      expect({ route: `${row.method} ${row.path}`, aliasOf: row.aliasOf }).toEqual({
        route: `${row.method} ${row.path}`,
        aliasOf: expected,
      });
    }
  });

  test('a legacy-only route has no canonical name served', () => {
    for (const key of legacyOnly) {
      const [method, path] = key.split(' ') as [string, string];
      expect({ key, canonical: endpoints.has(`${method} ${canonicalWorkspaceRoute(path)}`) }).toEqual({ key, canonical: false });
      expect({ key, legacy: endpoints.has(key) }).toEqual({ key, legacy: true });
    }
  });

  test('the legacy and canonical name maps invert each other', () => {
    for (const row of aliasRows) {
      expect(legacyWorkspaceRoute(row.aliasOf!)).toBe(row.path);
    }
  });
});

/**
 * "In the API routes it is all workspaces; projects and accounts are aliases"
 * (Marko, 2026-11-06). Every route whose path has a `projects` or `accounts`
 * segment is one of:
 *   - an alias of a canonical route (`aliasOf` in the manifest);
 *   - a legacy route with its own meaning, deprecated in the OpenAPI spec for
 *     its canonical replacement (`WORKSPACE_LEGACY_REPLACEMENTS`);
 *   - a retired route (410, `routes/retired.ts`);
 *   - on {@link NAMING_ALLOWLIST}, with the reason.
 * Staff routes (`/v1/admin/*`) are out of scope here. A new route that names
 * projects or accounts fails this test until it gets a workspace name.
 */
const NAMING_ALLOWLIST: Record<string, string> = {
  // A connector's connected third-party accounts (a Gmail address, a Slack
  // workspace): not Kortix accounts. The legacy twin under
  // /v1/connectors/projects/ is an alias of this canonical route.
  'GET /v1/connectors/workspaces/:workspaceId/connectors/:slug/accounts': 'third-party connected accounts',
};

describe('route naming: workspaces are canonical', () => {
  const NAMES_LEGACY_ENTITY = /\/(projects|accounts)(\/|$)/;
  const STAFF = /^\/v1\/admin(\/|$)/;

  test('every non-staff route that names projects or accounts is an alias, a deprecated legacy route, retired, or allowlisted', () => {
    const unexplained = manifest.routes
      .filter((r) => NAMES_LEGACY_ENTITY.test(r.path) && !STAFF.test(r.path))
      .map((r) => ({ key: `${r.method} ${r.path}`, aliasOf: r.aliasOf }))
      .filter(({ key, aliasOf }) => !aliasOf && !(key in WORKSPACE_LEGACY_REPLACEMENTS) && !retired.has(key) && !(key in NAMING_ALLOWLIST))
      .map(({ key }) => key);
    expect(unexplained).toEqual([]);
  });

  test('every allowlist and replacement row is a served route', () => {
    const keys = new Set(manifest.routes.map((r) => `${r.method} ${r.path}`));
    for (const key of [...Object.keys(NAMING_ALLOWLIST), ...Object.keys(WORKSPACE_LEGACY_REPLACEMENTS), ...Object.values(WORKSPACE_LEGACY_REPLACEMENTS)]) {
      expect({ key, served: keys.has(key) }).toEqual({ key, served: true });
    }
  });

  test('the project audit slice and the webhook fire are served under workspace names, same handlers', () => {
    for (const [legacy, canonical] of [
      ['GET /v1/projects/:workspaceId/audit', 'GET /v1/workspaces/:workspaceId/audit/events'],
      ['POST /v1/webhooks/projects/:workspaceId/:slug', 'POST /v1/webhooks/workspaces/:workspaceId/:slug'],
      ['POST /v1/projects/:workspaceId/transfer', 'POST /v1/workspaces/:workspaceId/transfer'],
      ['POST /v1/projects/create-repo', 'POST /v1/workspaces/create-repo'],
      ['POST /v1/projects/link-repository', 'POST /v1/workspaces/link-repository'],
    ] as const) {
      const a = endpoints.get(legacy)?.map(unwrap);
      const b = endpoints.get(canonical)?.map(unwrap);
      expect({ legacy, served: Boolean(a && b) }).toEqual({ legacy, served: true });
      expect({ legacy, same: a!.length === b!.length && a!.every((h, i) => h === b![i]) }).toEqual({ legacy, same: true });
    }
  });
});

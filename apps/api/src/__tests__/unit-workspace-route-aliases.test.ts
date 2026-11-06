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
 *   3. the committed manifest's `aliasOf` rows are exactly what the name map
 *      in `@kortix/shared/workspace-routes` computes.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  canonicalWorkspaceRoute,
  legacyWorkspaceRoute,
  WORKSPACE_LEGACY_ONLY_ROUTES,
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

const ALIASED_PREFIX = /^(\/v1\/projects|\/v1\/accounts\/:workspaceId\/|\/v1\/accounts\/me|\/v1\/account-invites|\/v1\/connectors\/projects\/|\/scim\/v2\/accounts\/)/;
const CANONICAL_PREFIX = /^(\/v1\/workspaces|\/v1\/me(\/|$)|\/v1\/invites|\/v1\/connectors\/workspaces\/|\/scim\/v2\/workspaces\/)/;
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

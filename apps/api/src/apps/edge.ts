/**
 * The self-host Apps edge: the small, UNAUTHENTICATED surface the operator's
 * own reverse proxy (Caddy) calls before it serves App traffic.
 *
 * Today it is one route — the on-demand-TLS gate. On a self-host box every App
 * publishes on `<env>-<slug>-<route-key>.{$KORTIX_APPS_BASE_DOMAIN}`. A second-
 * level wildcard certificate is impractical, so Caddy issues a certificate
 * PER-APP on the first request via ACME HTTP-01 (`on_demand`). Caddy requires a
 * global `on_demand_tls { ask <url> }` to bound that issuance: before minting a
 * certificate for a hostname it GETs `<url>?domain=<host>` and issues only on a
 * 2xx. This route is that `ask` endpoint — it returns 200 only for a real,
 * resolvable App public host, so a random hostname pointed at the box cannot
 * mint unbounded certificates.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { errors, json, makeOpenApiApp } from '../openapi';
import { resolveAppHost } from './hostnames';
import { loadPublicAppState } from './public-proxy';

/** Whether an App with this immutable route key exists and is servable. */
export type AppExistsCheck = (routeKey: string) => Promise<boolean>;

const defaultAppExists: AppExistsCheck = async (routeKey) => {
  // loadPublicAppState returns null when no App row matches the route key or
  // the project has the `apps` flag off — either way, not a host to issue a
  // certificate for. A deployed-but-cold App still returns a row, so its
  // certificate is minted for the cold-start page too.
  const state = await loadPublicAppState(routeKey);
  return state !== null;
};

/**
 * The HTTP status the on-demand-TLS `ask` answers with for `domain`:
 *   200 — a real App host; Caddy may issue a certificate.
 *   403 — not an App host shape (wrong domain, env prefix, or label form).
 *   404 — an App host shape, but no such App exists.
 * Split out from the route so it is testable without a running server or DB
 * (inject `appExists`).
 */
export async function appTlsCheckStatus(
  domain: string | null | undefined,
  appExists: AppExistsCheck = defaultAppExists,
): Promise<200 | 403 | 404> {
  if (!domain) return 403;
  const matched = resolveAppHost(domain);
  if (!matched) return 403;
  // Local `*.apps.localhost` hosts never use on-demand TLS; accept without a DB
  // round-trip so a dev box is never gated on it.
  if (matched.local) return 200;
  return (await appExists(matched.routeKey)) ? 200 : 404;
}

/** Build the edge app; `appExists` is injectable for tests. */
export function createAppEdgeApp(appExists: AppExistsCheck = defaultAppExists) {
  const edgeApp = makeOpenApiApp();

  edgeApp.openapi(
    createRoute({
      method: 'get',
      path: '/tls-check',
      tags: ['apps'],
      summary: 'On-demand-TLS gate: 200 iff <domain> is a real Kortix App host',
      request: { query: z.object({ domain: z.string().optional() }) },
      responses: {
        200: json(z.object({ ok: z.boolean() }), 'Domain is a servable App host'),
        ...errors(403, 404),
      },
    }),
    async (c) => {
      const status = await appTlsCheckStatus(c.req.query('domain'), appExists);
      if (status === 200) return c.json({ ok: true }, 200);
      return c.json(
        { error: true, message: status === 404 ? 'No such App host' : 'Not an App host', status },
        status,
      );
    },
  );

  return edgeApp;
}

export const appEdgeApp = createAppEdgeApp();

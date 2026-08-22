/**
 * The on-demand-TLS gate a SELF-HOST's own reverse proxy calls before it issues
 * a certificate for a hostname.
 *
 * Kortix Cloud fronts its wildcard domains with a Cloudflare Worker and one
 * advanced certificate pack. A self-host has neither: it runs the bundled Caddy,
 * which issues a certificate PER HOSTNAME on first request via ACME HTTP-01
 * (`tls { on_demand }`) — so the operator needs only a `*.<domain>` DNS record,
 * not a wildcard certificate. Caddy requires a global `on_demand_tls { ask
 * <url> }` to bound that: before minting anything it GETs `<url>?domain=<host>`
 * and issues only on a 2xx. Without the gate, any hostname pointed at the box
 * could mint unbounded certificates and burn the ACME rate limit.
 *
 * Caddy allows exactly ONE global `ask`, and a self-host can serve two wildcard
 * families — deployed Apps (`*.apps.<domain>`) and sandbox previews
 * (`*.p.<domain>`). So one endpoint answers for both, dispatching on which
 * hostname family the domain belongs to. `/v1/apps/edge/tls-check` stays where
 * it is for instances whose Caddyfile still points at it.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { errors, json, makeOpenApiApp } from '../openapi';
import { appTlsCheckStatus, type AppExistsCheck } from '../apps/edge';
import { resolvePreviewHost } from '../sandbox-proxy/preview-hosts';
import { resolveExternalIdFromHostLabel } from '../sandbox-proxy/backend';

/** Whether a sandbox with this host label exists. */
export type SandboxExistsCheck = (sandboxLabel: string) => Promise<boolean>;

const defaultSandboxExists: SandboxExistsCheck = async (sandboxLabel) =>
  (await resolveExternalIdFromHostLabel(sandboxLabel)) !== null;

/**
 * The status for a preview hostname:
 *   200 — a real preview host for a sandbox that exists.
 *   403 — not a preview host shape (wrong domain, env prefix, or label form).
 *   404 — the right shape, but no such sandbox.
 *
 * A stopped or sleeping sandbox still has a row, so its certificate is issued
 * too — opening the preview is expected to wake it, not to fail TLS.
 */
export async function previewTlsCheckStatus(
  domain: string | null | undefined,
  sandboxExists: SandboxExistsCheck = defaultSandboxExists,
): Promise<200 | 403 | 404> {
  if (!domain) return 403;
  const matched = resolvePreviewHost(domain);
  if (!matched) return 403;
  // `*.localhost` previews never use ACME; accept without a database round-trip.
  if (matched.local) return 200;
  return (await sandboxExists(matched.sandboxLabel)) ? 200 : 404;
}

/**
 * 200 if `domain` is a hostname this deployment actually serves — an App or a
 * sandbox preview. Checked in that order; they cannot both match, because the
 * two families sit under different base domains.
 */
export async function edgeTlsCheckStatus(
  domain: string | null | undefined,
  deps: { appExists?: AppExistsCheck; sandboxExists?: SandboxExistsCheck } = {},
): Promise<200 | 403 | 404> {
  const app = await appTlsCheckStatus(domain, deps.appExists);
  if (app !== 403) return app;
  return previewTlsCheckStatus(domain, deps.sandboxExists);
}

/** Build the edge app; the existence checks are injectable for tests. */
export function createEdgeApp(
  deps: { appExists?: AppExistsCheck; sandboxExists?: SandboxExistsCheck } = {},
) {
  const edgeApp = makeOpenApiApp();

  edgeApp.openapi(
    createRoute({
      method: 'get',
      path: '/tls-check',
      tags: ['apps'],
      summary: 'On-demand-TLS gate: 200 iff <domain> is a host this instance serves',
      request: { query: z.object({ domain: z.string().optional() }) },
      responses: {
        200: json(z.object({ ok: z.boolean() }), 'Domain is a servable host'),
        ...errors(403, 404),
      },
    }),
    async (c) => {
      const status = await edgeTlsCheckStatus(c.req.query('domain'), deps);
      if (status === 200) return c.json({ ok: true }, 200);
      return c.json(
        {
          error: true,
          message: status === 404 ? 'No such host' : 'Not a servable host',
          status,
        },
        status,
      );
    },
  );

  return edgeApp;
}

export const edgeApp = createEdgeApp();

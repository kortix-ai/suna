/**
 * Where a sandbox port is reachable in a browser.
 *
 * ONE resolver, used by BOTH the shape Kortix hands to clients
 * (`previewUrlTemplate`) and the matcher that accepts inbound preview traffic
 * (`resolvePreviewHost`) — the same split-brain that once published Apps on a
 * domain an operator did not own is exactly as available here, so the two
 * directions share one definition.
 *
 * ## Why a per-preview ORIGIN and not a path prefix
 *
 * The path form `/v1/p/{sandbox}/{port}/…` is a fine transport for programmatic
 * clients, and it stays. It is not a browser surface: an app served under a path
 * prefix escapes it the moment it emits anything root-absolute —
 * `<a href="/learn">`, `fetch('/api')`, `url(/bg.png)`, `pushState('/x')`, a
 * service worker scoped to `/`, `new WebSocket('/hmr')`. Rewriting HTML cannot
 * close that set; only giving the app its own origin can. That is also why
 * every comparable product (Codespaces, ngrok, StackBlitz, Daytona's own proxy)
 * routes previews by hostname.
 *
 * There is a second reason. Under the path form, arbitrary sandbox code runs on
 * the SAME origin as the Kortix API, so two of a user's previews share cookies,
 * storage, and a same-origin relationship with `/v1/p/…`. A per-preview origin
 * puts each app in its own security principal.
 *
 * ## The shape
 *
 *   deployed   {env}-p{port}-{sandbox-label}.{previewBaseDomain}
 *              dev-p8081-sbx-01m0g4hxcm32bx5r1gpyzdyc1h.p.kortix.com
 *   local      p{port}-{sandbox-label}.localhost:{apiPort}
 *
 * The env prefix is what lets dev, staging and prod share one wildcard
 * certificate and one edge Worker, exactly as Kortix Apps does. The sandbox
 * label is the external id lowercased with `_` → `-`, because DNS labels are
 * case-insensitive and cannot carry an underscore;
 * `resolveExternalIdFromHostLabel` resolves a label back to the canonical id
 * (see backend.ts).
 *
 * The local form has no env prefix and no configured domain: it is built by the
 * CLIENT (packages/sdk/src/core/session/url.ts) when it sees a localhost API,
 * and only matched here.
 */
import { config } from '../config';

/** `{env}-p{port}-{label}` on a real domain; `p{port}-{label}` on localhost. */
const DEPLOYED_LABEL = /^(dev|staging|prod|preview)-p(\d{1,5})-([a-z0-9-]+)$/;
const LOCAL_HOST = /^p(\d{1,5})-([a-z0-9-]+)\.localhost$/;

export interface ResolvedPreviewHost {
  /** DNS-safe sandbox label — resolve to a canonical row with `loadSandbox`. */
  sandboxLabel: string;
  port: number;
  local: boolean;
}

/**
 * A sandbox external id as a DNS label. Lowercase because browsers lowercase
 * the Host header, `_` → `-` because an underscore is not a legal hostname
 * character (browsers and CAs both reject it).
 */
export function sandboxHostLabel(externalId: string): string {
  return externalId.trim().toLowerCase().replaceAll('_', '-');
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\.+|\.+$/g, '');
}

/**
 * The wildcard domain every preview hostname sits under, or null when this
 * deployment has none.
 *
 * DECLARED, never derived. An earlier draft derived `p.<registrable domain of
 * KORTIX_URL>`, which reads well until KORTIX_URL is a cloudflared tunnel — a
 * worktree then advertised `p.trycloudflare.com`, a domain nobody serves, and
 * every preview URL it handed out was dead. A preview domain needs a wildcard
 * DNS record, a wildcard certificate and an edge Worker; none of those can be
 * inferred from an API hostname, so an operator states it or gets the path
 * proxy, which always works.
 */
export function previewBaseDomain(): string | null {
  const configured = config.KORTIX_PREVIEW_BASE_DOMAIN;
  return configured && normalizeDomain(configured) ? normalizeDomain(configured) : null;
}

/**
 * The template the SDK substitutes to build a preview URL without duplicating
 * the hostname shape client-side. `{port}` and `{sandbox}` are the only slots;
 * `{sandbox}` receives the RAW external id, which the client label-encodes the
 * same way `sandboxHostLabel` does.
 *
 * Null covers local development too, and deliberately: with no template the SDK
 * falls back to its own `p{port}-{sandbox}.localhost:{apiPort}` form, which is
 * correct precisely when the browser and the API share a machine — something
 * the API cannot determine about a client, and the client already knows.
 */
export function previewUrlTemplate(): string | null {
  const domain = previewBaseDomain();
  if (!domain) return null;
  return `https://${config.INTERNAL_KORTIX_ENV}-p{port}-{sandbox}.${domain}`;
}

/**
 * The full origin a sandbox port is served on, or null when this deployment has
 * no preview domain. `previewUrlTemplate` is the client-facing form of the same
 * fact; this is for the places the SERVER hands out a complete URL — today the
 * public-share viewer, which must point at the preview origin for a shared app
 * to behave like a real site rather than a path-prefixed one.
 */
export function previewOriginFor(externalId: string, port: number): string | null {
  const domain = previewBaseDomain();
  const label = sandboxHostLabel(externalId);
  if (!domain || !label || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `https://${config.INTERNAL_KORTIX_ENV}-p${port}-${label}.${domain}`;
}

/**
 * Match an inbound Host header. Returns null for every hostname that is not a
 * preview for THIS environment — including a well-formed preview label for a
 * different env, which must never be served by the wrong deployment.
 */
export function resolvePreviewHost(hostname: string): ResolvedPreviewHost | null {
  // Port first, then the FQDN trailing dot: a Host header may carry both
  // (`host.example.:443`), and stripping the dot first leaves it stranded.
  const host = (hostname || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

  const local = LOCAL_HOST.exec(host);
  if (local) {
    return { port: Number(local[1]), sandboxLabel: local[2]!, local: true };
  }

  const domain = previewBaseDomain();
  if (!domain || !host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, -(domain.length + 1));
  if (label.includes('.')) return null;
  const match = DEPLOYED_LABEL.exec(label);
  if (!match || match[1] !== config.INTERNAL_KORTIX_ENV) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { port, sandboxLabel: match[3]!, local: false };
}

/**
 * Cross-origin access to a preview, granted to the Kortix web app and nobody
 * else.
 *
 * The preview cookie is `SameSite=None` — it must be, for the session panel to
 * embed a preview — so the browser ATTACHES it to cross-site requests. Echoing
 * an arbitrary `Origin` back with `Allow-Credentials: true` therefore hands any
 * website a credentialed read of a signed-in user's preview. An allowlist is
 * the only safe form, and it lives here, once, because BOTH edges answer with
 * these headers and a policy in two places is a policy that drifts.
 *
 * Same-origin requests need none of this and are given none: callers pass ''.
 */
export function isAllowedPreviewOrigin(origin: string): boolean {
  const frontend = (config.FRONTEND_URL || '').trim();
  if (!frontend) return false;
  try {
    return new URL(origin).origin === new URL(frontend).origin;
  } catch {
    return false;
  }
}

export function previewCorsHeaders(origin: string): Record<string, string> {
  if (!origin || !isAllowedPreviewOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

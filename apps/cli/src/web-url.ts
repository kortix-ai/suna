/**
 * Resolve the Kortix FRONTEND (dashboard) base URL — never the API host.
 *
 * The CLI (and the in-sandbox agent that shells out to it) is connected to
 * Kortix over the API, so the only base URL it is handed is `KORTIX_API_URL`
 * (e.g. https://api-prod.kortix.com). User-facing links must point at the
 * frontend (e.g. https://kortix.com). Resolving them by string-munging the API
 * host is fragile — it silently produced `api-prod.kortix.com/projects/…`
 * links — so we never guess when an authoritative value is available.
 *
 * Resolution order, most authoritative first:
 *   1. An explicit `dashboardUrl` argument — e.g. a `Host`'s stored
 *      `dashboard_url` (see {@link Host} in api/config.ts), captured
 *      authoritatively at the source: `kortix self-host` knows its own
 *      `PUBLIC_URL` and stamps it on the `selfhost` host it registers, or
 *      `project.dashboard_url` — the server's own `config.FRONTEND_URL`,
 *      baked into every serialized project (see {@link projectWebUrl}).
 *   2. `KORTIX_FRONTEND_URL` — injected into every sandbox right next to
 *      `KORTIX_API_URL` (the server's `config.FRONTEND_URL`, verbatim). Also
 *      settable locally.
 *   3. `KORTIX_DASHBOARD_URL` — legacy local override, kept for back-compat.
 *   4. Derive from the API host (handles `api.`, `api-<env>.`, `<env>-api.`,
 *      localhost) — a best-effort fallback for old servers/hosts that carry
 *      neither (1) nor (2). NOTE: this guess assumes cloud URL conventions
 *      and a fixed local dev port pairing (`:8008` → `:3000`); it is WRONG
 *      for a self-host stack on other ports (e.g. the laptop default
 *      `:13738` API / `:13737` dashboard) — always prefer (1) when you have
 *      it, which is why a `Host` should carry `dashboard_url`.
 *   5. https://kortix.com.
 */
import { sandboxEnvValue } from './api/sandbox-env.ts';

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * The frontend dashboard base URL (no trailing slash), never the API host.
 *
 * @param dashboardUrl An authoritative override when the caller already
 *   knows it (e.g. `host.dashboard_url` from api/config.ts) — always pass
 *   this when available so a self-host stack on non-default ports resolves
 *   correctly instead of falling through to the API-shape guess.
 */
export function webDashboardUrl(apiBase: string, dashboardUrl?: string | null): string {
  if (dashboardUrl && dashboardUrl.trim()) return stripTrailingSlash(dashboardUrl.trim());
  const explicit = sandboxEnvValue('KORTIX_FRONTEND_URL') || process.env.KORTIX_DASHBOARD_URL;
  if (explicit && explicit.trim()) return stripTrailingSlash(explicit.trim());
  return stripTrailingSlash(deriveFrontendFromApiBase(apiBase));
}

/** Best-effort map of an API host to its frontend host (fallback only). */
function deriveFrontendFromApiBase(apiBase: string): string {
  try {
    const url = new URL(apiBase);
    const host = url.hostname;

    // Local self-host: api at :8008 → dashboard at :3000.
    if (host === 'localhost' || host === '127.0.0.1') {
      return `${url.protocol}//${host}:3000`;
    }
    // api.kortix.com → kortix.com
    if (host.startsWith('api.')) {
      url.hostname = host.slice(4);
      return url.origin;
    }
    // api-prod.kortix.com → kortix.com ; api-dev.kortix.com → dev.kortix.com
    const apiEnv = host.match(/^api-([a-z0-9]+)\.(.+)$/i);
    if (apiEnv) {
      const env = apiEnv[1].toLowerCase();
      const rest = apiEnv[2];
      url.hostname = env === 'prod' || env === 'production' ? rest : `${env}.${rest}`;
      return url.origin;
    }
    // dev-api.kortix.com → dev.kortix.com (any <env>-api.<domain>)
    if (host.includes('-api.')) {
      url.hostname = host.replace('-api.', '.');
      return url.origin;
    }
    return url.origin;
  } catch {
    return 'https://kortix.com';
  }
}

/**
 * Web (dashboard) URL for a project. Prefers the server-provided `dashboardUrl`
 * (authoritative) and only falls back to {@link webDashboardUrl} when absent.
 */
export function projectWebUrl(
  apiBase: string,
  projectId: string,
  dashboardUrl?: string | null,
): string {
  if (dashboardUrl && dashboardUrl.trim()) return stripTrailingSlash(dashboardUrl.trim());
  return `${webDashboardUrl(apiBase)}/projects/${projectId}`;
}

/** Web (dashboard) URL for a session within a project. */
export function sessionWebUrl(
  apiBase: string,
  projectId: string,
  sessionId: string,
  dashboardUrl?: string | null,
): string {
  return `${projectWebUrl(apiBase, projectId, dashboardUrl)}/sessions/${sessionId}`;
}

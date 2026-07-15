// Reachability for the self-host `kortix-api` service: how a cloud (Daytona)
// sandbox — which runs on a remote VM outside the operator's network — calls
// back to this instance's API. Three modes (see reachabilityMode below):
//
//   - domain:  a public DNS domain + the bundled Caddy reverse proxy/TLS.
//   - tunnel:  no domain — a Cloudflare tunnel exposes the API publicly.
//              Zero-config default: an ephemeral quick tunnel
//              (`cloudflared tunnel --url ...`), whose https://*.trycloudflare.com
//              URL changes every restart and must be re-captured. Optional
//              stable alternative: a NAMED tunnel — set CLOUDFLARE_TUNNEL_TOKEN
//              (+ CLOUDFLARE_TUNNEL_HOSTNAME, the DNS hostname bound to that
//              tunnel in the Cloudflare Zero Trust dashboard) and the hostname
//              itself becomes KORTIX_URL, no log-scraping needed.
//   - local:   loopback only. Agent sandboxes and any other external caller
//              (webhooks, Slack/Teams OAuth, git-proxy clone URLs) cannot
//              reach this instance. Browser-local flows (e.g. creating a
//              GitHub App) still work since the browser runs on the same
//              machine.
//
// Pure data/string helpers only — no filesystem/docker access — so this is
// trivially unit-testable. `commands/self-host.ts` supplies the actual
// `docker compose logs` read as a callback into resolveTunnelUrl().

export type ReachabilityMode = 'domain' | 'tunnel' | 'local';

/**
 * Resolve the ACTUAL reachability mode for a given env snapshot. KORTIX_DOMAIN
 * being set always wins (domain mode) regardless of any persisted preference —
 * mirrors how KORTIX_APP_REPLICAS/Caddy already treat KORTIX_DOMAIN as the
 * single source of truth for "is this a public-domain deployment". Otherwise
 * falls back to the persisted KORTIX_REACHABILITY_MODE preference (only
 * meaningful choice left is tunnel vs. local), defaulting to local — the safe,
 * backward-compatible default matching every self-host instance created
 * before this feature existed.
 */
export function reachabilityMode(env: Record<string, string | undefined>): ReachabilityMode {
  if (env.KORTIX_DOMAIN?.trim()) return 'domain';
  if (env.KORTIX_REACHABILITY_MODE === 'tunnel') return 'tunnel';
  return 'local';
}

/**
 * A stable NAMED tunnel is configured when both the token (authenticates
 * cloudflared to run that specific tunnel) and its bound public hostname
 * (assigned to the tunnel in the Cloudflare dashboard) are set. When true,
 * KORTIX_URL is derived directly from the hostname — no log-scraping, and the
 * URL never changes across restarts, unlike the zero-config quick tunnel.
 */
export function namedTunnelConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CLOUDFLARE_TUNNEL_TOKEN?.trim() && env.CLOUDFLARE_TUNNEL_HOSTNAME?.trim());
}

const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

/**
 * Extract the ephemeral https://<random>.trycloudflare.com URL cloudflared
 * prints to its stdout/stderr when it establishes a zero-config quick tunnel.
 * A pure string function so it's unit-testable without any docker/process
 * plumbing — resolveTunnelUrl below is the only caller in normal operation.
 *
 * Returns the LAST match, not the first: `docker compose logs` returns the
 * cloudflared container's ENTIRE cumulative log history, not just since its
 * most recent boot. If the container was restarted in place (e.g. it crashed
 * and Compose's `restart: unless-stopped` brought it back, or the operator ran
 * `docker restart cloudflared`) rather than recreated, those logs still
 * contain the previous, now-dead quick-tunnel URL followed by the fresh one
 * cloudflared mints on every boot. Taking the first match would silently pin
 * KORTIX_URL to a tunnel that no longer exists — this is confirmed live: a
 * bare `docker restart` of the cloudflared container followed by
 * `kortix self-host start` used to re-resolve the STALE pre-restart URL.
 */
export function parseQuickTunnelUrl(logText: string): string | null {
  const matches = logText.match(QUICK_TUNNEL_URL_PATTERN);
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

export interface TunnelUrlResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Resolve the public KORTIX_URL for tunnel-reachability mode.
 *
 * - Named tunnel (CLOUDFLARE_TUNNEL_TOKEN + CLOUDFLARE_TUNNEL_HOSTNAME): the
 *   hostname IS the URL, resolved instantly — cloudflared is authenticating to
 *   a tunnel that was already bound to that hostname out-of-band, so there's
 *   nothing to discover.
 * - Otherwise (the zero-config default): poll `readLogs()` — the caller's
 *   `docker compose logs cloudflared` (or equivalent) — for the quick-tunnel
 *   URL cloudflared prints at boot, up to `timeoutMs`. The URL is EPHEMERAL:
 *   a fresh one is minted every time the `cloudflared` container restarts, so
 *   this must be re-run on every `start`/`update`, not just the first one.
 */
export async function resolveTunnelUrl(
  env: Record<string, string | undefined>,
  readLogs: () => string,
  timeoutMs = 30_000,
  pollIntervalMs = 1_000,
): Promise<TunnelUrlResult> {
  if (namedTunnelConfigured(env)) {
    return { ok: true, url: `https://${env.CLOUDFLARE_TUNNEL_HOSTNAME!.trim().replace(/^https?:\/\//, '')}` };
  }

  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = parseQuickTunnelUrl(readLogs());
    if (url) return { ok: true, url };
    if (attempt < attempts - 1) await sleep(pollIntervalMs);
  }
  return {
    ok: false,
    error:
      'Timed out waiting for the Cloudflare quick tunnel URL. Check `kortix self-host logs cloudflared` — ' +
      'cloudflared may still be pulling its image, or may be missing/blocked. Agent sandboxes will not be ' +
      'reachable until this resolves; re-run `kortix self-host start` once it is.',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

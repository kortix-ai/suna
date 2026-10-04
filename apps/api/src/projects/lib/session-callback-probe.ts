







import { config } from '../../lib/config';






















































import { deriveKortixApiBase } from './session-sandbox-env-build';
/**
 * Cloud sandboxes reach the control plane over the public internet via
 * `$KORTIX_API_URL`. A loopback/unspecified host is never reachable from
 * inside a remote sandbox, so a session booted against one is
 * dead-on-arrival: repo materialization can't fetch its git clone credential and
 * the daemon ends up reporting "OpenCode runtime is not ready" with a cryptic
 * "Unable to connect" boot error ~60s later. Detect it up front so session
 * creation fails fast with an actionable message instead.
 *
 * Returns a human-readable reason string when unreachable, or null when fine.
 */

export function sandboxCallbackUnreachableReason(): string | null {
  let host: string;
  try {
    host = new URL(deriveKortixApiBase()).hostname.toLowerCase();
  } catch {
    return `KORTIX_URL is not a valid URL: ${config.KORTIX_URL || '(unset)'}`;
  }
  const isLoopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host.startsWith('127.') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]';
  if (!isLoopback) return null;
  return (
    `KORTIX_URL points at a loopback address (${config.KORTIX_URL}). ` +
    `Cloud sandboxes run remotely and cannot call back to your machine's localhost, ` +
    `so the agent runtime will never boot. Start the dev tunnel with \`pnpm dev\` ` +
    `(it provisions a public Cloudflare URL automatically and exports it as KORTIX_URL), ` +
    `or set a public KORTIX_URL in apps/api/.env.`
  );
}

// One probe verdict is cached briefly: session create and restart are
// user-facing paths and must not pay a fresh network round-trip on every call.
const TUNNEL_PROBE_TTL_MS = 30_000;
const TUNNEL_PROBE_TIMEOUT_MS = 3_000;
let tunnelProbe: { base: string; reason: string | null; at: number } | null = null;

/** Test seam: drop the cached verdict so a test can force a fresh probe. */
export function resetTunnelProbeCache(): void {
  tunnelProbe = null;
}

/**
 * Liveness check for a quick-tunnel KORTIX_URL. The static loopback check
 * above catches a MISSING tunnel; this catches a DEAD one. trycloudflare quick
 * tunnels die server-side while the local `cloudflared` process stays up, and
 * every sandbox created after that boots into a callback URL that can never
 * answer — the runtime never becomes ready and the failure used to surface as
 * a false "computer was lost" (incident 2026-08-14). Scoped to
 * *.trycloudflare.com on purpose: deployed environments use a stable public
 * URL and must not pay a self-probe on the session-create path.
 */
export async function sandboxCallbackDeadTunnelReason(
  now = Date.now(),
  base = deriveKortixApiBase(),
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return null; // sandboxCallbackUnreachableReason() already reports an invalid URL
  }
  if (!host.endsWith('.trycloudflare.com')) return null;
  if (tunnelProbe && tunnelProbe.base === base && now - tunnelProbe.at < TUNNEL_PROBE_TTL_MS) {
    return tunnelProbe.reason;
  }
  let reason: string | null = null;
  try {
    const res = await fetchImpl(`${base}/health`, {
      signal: AbortSignal.timeout(TUNNEL_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      reason =
        `The dev tunnel at ${config.KORTIX_URL} answered ${res.status} to a health probe. ` +
        `Cloud sandboxes cannot call back to this API through it, so a new sandbox would ` +
        `boot but never become ready. Restart the dev stack (\`pnpm dev\`) to mint a fresh tunnel.`;
    }
  } catch {
    reason =
      `The dev tunnel at ${config.KORTIX_URL} is not answering. Cloud sandboxes cannot ` +
      `call back to this API through it, so a new sandbox would boot but never become ` +
      `ready. Restart the dev stack (\`pnpm dev\`) to mint a fresh tunnel.`;
  }
  tunnelProbe = { base, reason, at: now };
  return reason;
}

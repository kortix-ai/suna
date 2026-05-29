/**
 * Minimal reach-and-exec for legacy JustAVPS VMs, used only by the migration.
 *
 * The new backend has no JustAVPS provider, but legacy sandboxes still run on
 * always-on JustAVPS hosts reachable through the Cloudflare proxy at
 * `{slug}.{JUSTAVPS_PROXY_DOMAIN}`. Shell exec goes through the Daytona toolbox
 * daemon on that host (`POST /toolbox/process/execute`), authenticated with the
 * per-sandbox proxy token (stored in the sandbox row metadata) + the service
 * key. This mirrors the legacy provider's resolveEndpoint + update/exec.ts.
 */
import { config } from '../config';
import { logger as appLogger } from '../lib/logger';

type LegacySandboxLike = {
  externalId: string | null;
  baseUrl: string | null;
  config: unknown;
  metadata: unknown;
};

export interface LegacyVmEndpoint {
  url: string;
  headers: Record<string, string>;
}

/**
 * Shell snippet that sets $WS (workspace) and $OC (OpenCode store) on the VM,
 * shared by every step + the probe so detection can't drift. Mirrors OpenCode's
 * getOpencodeStorageBase() priority, plus a /home/<user>/ fallback — observed in
 * the wild the store lives at /home/user/.local/share/opencode while the exec
 * shell's $HOME is /root. $OC is '' when no store is found.
 */
export const RESOLVE_WS_OC_SH = [
  // JustAVPS runs the kortix sandbox in a NESTED docker container; the real
  // /workspace (user files + OpenCode store) lives in the workload container's
  // volume on the host (justavps-data), not the host's own /workspace. Target
  // that volume first, then fall back to host/Daytona-style paths.
  'WS=/var/lib/docker/volumes/justavps-data/_data',
  '[ -d "$WS/.local/share/opencode" ] || WS="$(ls -d /var/lib/docker/volumes/*/_data 2>/dev/null | head -1)"',
  '[ -d "$WS" ] || WS="${KORTIX_WORKSPACE:-/workspace}"',
  'if [ -n "${OPENCODE_STORAGE_BASE:-}" ] && [ -d "$OPENCODE_STORAGE_BASE" ]; then OC="$OPENCODE_STORAGE_BASE";',
  'elif [ -d "$WS/.local/share/opencode" ]; then OC="$WS/.local/share/opencode";',
  'elif [ -n "${KORTIX_PERSISTENT_ROOT:-}" ] && [ -d "$KORTIX_PERSISTENT_ROOT/opencode" ]; then OC="$KORTIX_PERSISTENT_ROOT/opencode";',
  'elif [ -d /persistent/opencode ]; then OC=/persistent/opencode;',
  'elif [ -d "$HOME/.local/share/opencode" ]; then OC="$HOME/.local/share/opencode";',
  'else OC="$(ls -d /var/lib/docker/volumes/*/_data/.local/share/opencode /home/*/.local/share/opencode 2>/dev/null | head -1)"; fi',
].join('\n');

export interface LegacyExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Stale if no expiry recorded (legacy tokens) or within ~1 day of expiring. */
function isProxyTokenStale(meta: Record<string, unknown>): boolean {
  const expiresAt = meta.justavpsProxyTokenExpiresAt;
  if (typeof expiresAt !== 'string' && typeof expiresAt !== 'number') return true;
  const expiryMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryMs)) return true;
  return expiryMs - Date.now() < 24 * 60 * 60 * 1000;
}

const PROXY_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Minimal authed call to the JustAVPS control API (mirrors the legacy provider). */
async function justavpsFetch<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const baseUrl = config.JUSTAVPS_API_URL.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.JUSTAVPS_API_KEY}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`JustAVPS API ${options.method ?? 'GET'} ${path} -> ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

/** Look up a machine's slug from its id. */
async function fetchMachineSlug(externalId: string): Promise<string> {
  const machine = await justavpsFetch<{ slug?: string }>(`/machines/${externalId}`);
  if (!machine.slug) throw new Error(`JustAVPS machine ${externalId} has no slug`);
  return machine.slug;
}

/** Mint a fresh CF-proxy token for a machine. */
async function mintProxyToken(externalId: string): Promise<string | null> {
  try {
    const res = await justavpsFetch<{ token: string }>('/proxy-tokens', {
      method: 'POST',
      body: { machine_id: externalId, label: `kortix-migration-${externalId}`, expires_in_seconds: PROXY_TOKEN_TTL_SECONDS },
    });
    return res.token ?? null;
  } catch (err) {
    appLogger.warn('[legacy-vm] failed to mint proxy token', {
      externalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the reachable toolbox endpoint + auth headers for a legacy VM.
 *
 * Prefers what's already on the sandbox row (slug + a fresh proxy token), but
 * falls back to the JustAVPS control API when those are missing or stale — so
 * given only the machine id + JUSTAVPS_API_KEY we can derive the slug (GET
 * /machines/{id}) and mint a fresh proxy token (POST /proxy-tokens). Throws with
 * an actionable message if it still can't reach the VM.
 */
export async function resolveLegacyVmEndpoint(legacy: LegacySandboxLike): Promise<LegacyVmEndpoint> {
  const meta = asRecord(legacy.metadata);
  const cfg = asRecord(legacy.config);

  let slug = typeof meta.justavpsSlug === 'string' ? meta.justavpsSlug : undefined;
  let proxyToken = typeof meta.justavpsProxyToken === 'string' ? meta.justavpsProxyToken : undefined;
  let url = legacy.baseUrl || '';
  const urlUnusable = !url || url.includes('/machines/') || url.startsWith('http://');
  const apiConfigured = Boolean(config.JUSTAVPS_API_KEY) && Boolean(legacy.externalId);

  // Derive slug / mint token from the JustAVPS API when needed and possible.
  if (apiConfigured) {
    if (urlUnusable && !slug) slug = await fetchMachineSlug(legacy.externalId!);
    if (!proxyToken || isProxyTokenStale(meta)) {
      const minted = await mintProxyToken(legacy.externalId!);
      if (minted) proxyToken = minted;
    }
  }

  if (urlUnusable) {
    if (!slug) {
      throw new Error(
        `Legacy VM ${legacy.externalId ?? '(no external id)'} has no usable baseUrl and no slug; set JUSTAVPS_API_KEY so it can be resolved from the machine id`,
      );
    }
    url = `https://${slug}.${config.JUSTAVPS_PROXY_DOMAIN}`;
  }
  url = url.replace(/\/+$/, '');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (proxyToken) headers['X-Proxy-Token'] = proxyToken;
  const serviceKey = typeof cfg.serviceKey === 'string' ? cfg.serviceKey : undefined;
  headers['Authorization'] = `Bearer ${serviceKey || config.INTERNAL_SERVICE_KEY}`;

  return { url, headers };
}

/**
 * Run a shell command on the legacy VM via the toolbox daemon. `timeoutSec` is
 * the daemon-side timeout; the HTTP request waits a bit longer.
 */
export async function execOnLegacyVm(
  endpoint: LegacyVmEndpoint,
  command: string,
  timeoutSec = 120,
): Promise<LegacyExecResult> {
  const resp = await fetch(`${endpoint.url}/toolbox/process/execute`, {
    method: 'POST',
    headers: endpoint.headers,
    body: JSON.stringify({ command, timeout: timeoutSec }),
    signal: AbortSignal.timeout((timeoutSec + 30) * 1000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return {
      success: false,
      stdout: '',
      stderr: `toolbox error (${resp.status}): ${text.slice(0, 800)}`,
      exitCode: -1,
    };
  }

  const data = (await resp.json()) as {
    exit_code?: number;
    stdout?: string;
    stderr?: string;
  };
  const exitCode = data.exit_code ?? -1;
  return {
    success: exitCode === 0,
    stdout: data.stdout ?? '',
    stderr: data.stderr ?? '',
    exitCode,
  };
}

/** Exec + throw on non-zero exit, returning stdout. Convenience for steps. */
export async function execOnLegacyVmOrThrow(
  endpoint: LegacyVmEndpoint,
  command: string,
  timeoutSec = 120,
): Promise<string> {
  const result = await execOnLegacyVm(endpoint, command, timeoutSec);
  if (!result.success) {
    throw new Error(`VM command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`.slice(0, 1000));
  }
  return result.stdout;
}

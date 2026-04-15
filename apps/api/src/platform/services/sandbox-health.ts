/**
 * Sandbox Health Monitor
 *
 * Periodic health check that ensures kortix-api can always reach the sandbox.
 * Self-heals by re-syncing the canonical sandbox auth bundle on auth failures.
 *
 * Runs every HEALTH_CHECK_INTERVAL_MS. On failure:
 *   1. Attempts key sync (up to 3 times with backoff)
 *   2. Logs connectivity state changes
 *   3. Exposes state for admin/debug endpoints
 */

import { config } from '../../config';
import { buildCanonicalSandboxAuthCommand, getAuthCandidates, getLocalSandboxServiceKey } from './sandbox-auth';

// ─── State ───────────────────────────────────────────────────────────────────

export interface SandboxHealthState {
  connected: boolean;
  lastCheck: number;
  lastSuccess: number;
  lastError: string | null;
  syncAttempts: number;
  consecutiveFailures: number;
}

const state: SandboxHealthState = {
  connected: false,
  lastCheck: 0,
  lastSuccess: 0,
  lastError: null,
  syncAttempts: 0,
  consecutiveFailures: 0,
};

let _intervalId: ReturnType<typeof setInterval> | null = null;

const HEALTH_CHECK_INTERVAL_MS = 60_000;   // 60s between checks
const HEALTH_TIMEOUT_MS = 5_000;           // 5s timeout per check
const MAX_SYNC_RETRIES = 3;
const SYNC_BACKOFF_MS = [2_000, 5_000, 10_000]; // progressive backoff

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function buildDockerEnvWriteCommand(payload: Record<string, string>, targetDir: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `mkdir -p ${targetDir} && ENV_WRITE_PAYLOAD_B64=${shellQuote(payloadB64)} python3 - <<PY
import base64, json, os
from pathlib import Path

target_dir = Path(${JSON.stringify(targetDir)})
target_dir.mkdir(parents=True, exist_ok=True)
payload = json.loads(base64.b64decode(os.environ["ENV_WRITE_PAYLOAD_B64"]).decode("utf-8"))
for key, value in payload.items():
    (target_dir / key).write_text(value)
PY`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getSandboxHealthState(): SandboxHealthState {
  return { ...state };
}

/**
 * Start the periodic health monitor.
 * Safe to call multiple times — only one interval runs.
 */
export function startSandboxHealthMonitor(): void {
  if (_intervalId) return;

  // Run first check after a short delay (let startup complete)
  setTimeout(() => {
    checkSandboxHealth();
    _intervalId = setInterval(checkSandboxHealth, HEALTH_CHECK_INTERVAL_MS);
  }, 5_000);

  console.log('[sandbox-health] Monitor started (interval: 60s)');
}

export function stopSandboxHealthMonitor(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}

// ─── Core ────────────────────────────────────────────────────────────────────

async function checkSandboxHealth(): Promise<void> {
  state.lastCheck = Date.now();

  const baseUrl = config.SANDBOX_NETWORK
    ? `http://${config.SANDBOX_CONTAINER_NAME}:8000`
    : `http://localhost:${config.SANDBOX_PORT_BASE}`;
  const canonicalServiceKey = await getLocalSandboxServiceKey();
  const authCandidates = getAuthCandidates(canonicalServiceKey);

  try {
    // 1. Check basic reachability (health endpoint bypasses auth)
    // 503 means Kortix Master is running but the agent runtime isn't ready yet —
    // treat it as a soft failure (sandbox is reachable but not fully ready).
    const healthRes = await fetch(`${baseUrl}/kortix/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });

    if (healthRes.status === 503) {
      // Sandbox is reachable but the runtime is still starting — not a hard failure.
      // Mark as connected (infra is up) but log that the runtime isn't ready.
      const wasDisconnected = !state.connected;
      state.connected = true;
      state.lastCheck = Date.now();
      state.consecutiveFailures = 0;
      state.lastError = 'Runtime not ready (503 starting)';
      if (wasDisconnected) {
        console.log('[sandbox-health] Sandbox reachable but runtime still starting');
      }
      return;
    }

    if (!healthRes.ok) {
      throw new Error(`Health returned ${healthRes.status}`);
    }

    // 2. Check auth works (protected endpoint)
    const fetchAuthorized = async (): Promise<Response> => {
      for (const authToken of authCandidates) {
        const res = await fetch(`${baseUrl}/kortix/ports`, {
          headers: { Authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (res.status !== 401 && res.status !== 403) return res;
      }
      return fetch(`${baseUrl}/kortix/ports`, {
        headers: { Authorization: `Bearer ${authCandidates[0] || ''}` },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
    };

    const authRes = await fetchAuthorized();

    if (authRes.status === 401) {
      // Auth mismatch — try to sync key
      console.warn('[sandbox-health] Auth failed (401), attempting key sync...');
      const synced = await attemptKeySync(baseUrl, canonicalServiceKey, authCandidates);
      if (!synced) {
        throw new Error('Auth failed and key sync unsuccessful');
      }
      // Key synced — verify again
      const retryRes = await fetchAuthorized();
      if (!retryRes.ok) {
        throw new Error(`Auth still failing after key sync (${retryRes.status})`);
      }
    } else if (!authRes.ok) {
      throw new Error(`Ports endpoint returned ${authRes.status}`);
    }

    // Success
    const wasDisconnected = !state.connected;
    state.connected = true;
    state.lastSuccess = Date.now();
    state.lastError = null;
    state.consecutiveFailures = 0;

    if (wasDisconnected) {
      console.log('[sandbox-health] Connection restored');
    }
  } catch (err: any) {
    state.connected = false;
    state.consecutiveFailures++;
    state.lastError = err.message || String(err);

    // Only log periodically to avoid spam
    if (state.consecutiveFailures <= 3 || state.consecutiveFailures % 10 === 0) {
      console.error(`[sandbox-health] Check failed (${state.consecutiveFailures}x): ${state.lastError}`);
    }
  }
}

/**
 * Attempt to sync the canonical auth bundle + API URLs to the sandbox container.
 * Tries the secrets manager /env API first (preferred — triple-write + no restart needed).
 * Falls back to docker exec if the API is unreachable (e.g. kortix-master down).
 */
async function attemptKeySync(baseUrl: string, canonicalServiceKey: string, authCandidates: string[]): Promise<boolean> {
  if (!canonicalServiceKey) return false;

  // Compute the correct internal API URL for the sandbox (same logic as local-docker.ts)
  let internalApiUrl = `http://host.docker.internal:${config.PORT}`;
  if (config.KORTIX_URL) {
    try {
      const parsed = new URL(config.KORTIX_URL);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        parsed.hostname = 'host.docker.internal';
        internalApiUrl = parsed.toString().replace(/\/$/, '');
      } else {
        internalApiUrl = config.KORTIX_URL.replace(/\/$/, '');
      }
    } catch {}
  }

  const keysToSync: Record<string, string> = {
    KORTIX_TOKEN: canonicalServiceKey,
    INTERNAL_SERVICE_KEY: canonicalServiceKey,
    TUNNEL_TOKEN: canonicalServiceKey,
    KORTIX_API_URL: internalApiUrl,
    TUNNEL_API_URL: internalApiUrl,
    ...(config.ENV_MODE === 'cloud' ? {
      KORTIX_YOLO_API_KEY: canonicalServiceKey,
      KORTIX_YOLO_URL: config.KORTIX_YOLO_URL,
    } : {}),
  };

  for (let attempt = 0; attempt < MAX_SYNC_RETRIES; attempt++) {
    try {
      state.syncAttempts++;
      console.log(`[sandbox-health] Core env sync attempt ${attempt + 1}/${MAX_SYNC_RETRIES}...`);

      // Preferred: use secrets manager /env API (triple-write, no restart needed)
      const envApiUrl = `${baseUrl}/env`;
      let envApiSynced = false;
      for (const authToken of authCandidates) {
        const res = await fetch(envApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ keys: keysToSync }),
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          console.log(`[sandbox-health] Core env sync successful via /env API (attempt ${attempt + 1})`);
          return true;
        }

        if (res.status !== 401 && res.status !== 403) {
          console.warn(`[sandbox-health] /env API returned ${res.status}, retrying...`);
          envApiSynced = true;
          break;
        }
      }

      if (!envApiSynced) {
        console.warn('[sandbox-health] /env API auth candidates exhausted, falling back to docker exec...');
        if (await attemptKeySyncFallback(keysToSync)) return true;
      }
    } catch (err: any) {
      console.warn(`[sandbox-health] /env API unreachable (attempt ${attempt + 1}), trying docker exec fallback...`);
      // /env API not reachable — try docker exec fallback
      if (await attemptKeySyncFallback(keysToSync)) return true;
    }

    // Backoff before retry
    const backoff = SYNC_BACKOFF_MS[attempt] || 10_000;
    await new Promise(r => setTimeout(r, backoff));
  }

  return false;
}

/**
 * Fallback: write core env vars directly to s6 env dir via docker exec.
 * Used when the /env API is unreachable (e.g. kortix-master auth mismatch).
 */
async function attemptKeySyncFallback(keys: Record<string, string>): Promise<boolean> {
  // Only works in local docker mode (not network mode)
  if (config.SANDBOX_NETWORK) {
    console.warn('[sandbox-health] Cannot use docker exec fallback in network mode');
    return false;
  }

  try {
    const { execSync } = require('child_process');
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (config.DOCKER_HOST && !config.DOCKER_HOST.includes('://')) {
      env.DOCKER_HOST = `unix://${config.DOCKER_HOST}`;
    }

    const token = keys.KORTIX_TOKEN || keys.INTERNAL_SERVICE_KEY || '';
    const apiUrl = keys.KORTIX_API_URL || keys.TUNNEL_API_URL || '';
    execSync(
      `docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} bash -c ${shellQuote(buildCanonicalSandboxAuthCommand(token, apiUrl))}`,
      { timeout: 15_000, stdio: 'pipe', env },
    );

    console.log(`[sandbox-health] Core env sync successful via docker exec fallback`);
    return true;
  } catch (err: any) {
    console.error(`[sandbox-health] Docker exec fallback failed:`, err.message || err);
    return false;
  }
}

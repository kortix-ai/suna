/**
 * Sandbox Preview Proxy — transparent pipe to Kortix Master inside the sandbox.
 *
 * TRUE TRANSPARENT PROXY:
 *   - decompress: false — raw bytes pass through untouched
 *   - Response body streamed 1:1 (never buffered)
 *   - SSE / long-lived streams work correctly (connection-timeout only, no body timeout)
 *   - Only touches: Host, Authorization (service key), CORS
 *
 * Called from index.ts for both path-based (/v1/p/:id/:port/*)
 * and subdomain-based (p{port}-{sandboxId}.localhost) routing.
 *
 * WebSocket upgrades are handled at the Bun server level (see index.ts).
 */

import { config } from '../../config';
import { execSync } from 'child_process';
import { buildCanonicalSandboxAuthCommand } from '../../platform/services/sandbox-auth';
import { invalidateProviderCache } from '..';

const KORTIX_MASTER_PORT = 8000;
const FETCH_TIMEOUT_MS = 30_000;

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

function isExpectedStartupPreview(path: string, status: number, bodySnippet: string): boolean {
  if (status !== 502 && status !== 503) return false;
  const normalizedPath = path.split('?')[0];
  const startupPaths = [
    '/question',
    '/global/health',
    '/global/event',
    '/session/status',
    '/kortix/health',
    '/log',
  ];
  return startupPaths.some((candidate) => normalizedPath.startsWith(candidate)) && (
    bodySnippet.includes('Port 8000 — Not Reachable') ||
    bodySnippet.includes('no such host') ||
    bodySnippet.includes('connection refused') ||
    bodySnippet.includes('Bad Gateway')
  );
}

// ─── Service Key Sync ────────────────────────────────────────────────────────
// Ensures the running sandbox container has the canonical auth bundle from
// the DB. Triggered on 401 from the sandbox (auth drift after a rotation).
//
// Previously this used a one-shot boolean (`_serviceKeySynced`) — once we
// successfully synced ONE key, all future 401s were ignored. That broke
// `bun --hot` reloads: every API restart re-provisions the sandbox with a
// fresh kortix_sb_ token, the browser keeps hitting the proxy with a JWT,
// the proxy resolves the NEW serviceKey, but we refuse to resync and just
// serve 401s until the page is manually hard-refreshed.
//
// Fix: track the last successfully-synced key. If the current key differs
// from the last-synced one (rotation happened), allow a fresh sync cycle.
const MAX_SYNC_ATTEMPTS_PER_KEY = 3;
let _lastSyncedKey: string | null = null;
let _syncAttemptsForCurrentKey = 0;

function trySyncServiceKey(serviceKey: string): boolean {
  if (!serviceKey) return false;
  // New key → reset the attempt counter so a rotation gets a fresh 3 tries.
  if (serviceKey !== _lastSyncedKey) {
    _syncAttemptsForCurrentKey = 0;
  } else if (_syncAttemptsForCurrentKey >= MAX_SYNC_ATTEMPTS_PER_KEY) {
    // Already synced this exact key successfully — nothing to do.
    return false;
  }
  _syncAttemptsForCurrentKey++;
  try {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (config.DOCKER_HOST && !config.DOCKER_HOST.includes('://')) {
      env.DOCKER_HOST = `unix://${config.DOCKER_HOST}`;
    }

    console.log(`[LOCAL-PREVIEW] Syncing sandbox auth bundle to container (attempt ${_syncAttemptsForCurrentKey}/${MAX_SYNC_ATTEMPTS_PER_KEY})...`);
    execSync(
      `docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} bash -c ${shellQuote(buildCanonicalSandboxAuthCommand(serviceKey, config.KORTIX_URL.replace(/\/v1\/router\/?$/, '') || `http://host.docker.internal:${config.PORT}`))}`,
      { timeout: 15_000, stdio: 'pipe', env },
    );
    _lastSyncedKey = serviceKey;
    console.log('[LOCAL-PREVIEW] Sandbox auth bundle synced');
    return true;
  } catch (err: any) {
    console.error(`[LOCAL-PREVIEW] Failed to sync sandbox auth bundle (attempt ${_syncAttemptsForCurrentKey}/${MAX_SYNC_ATTEMPTS_PER_KEY}):`, err.message || err);
    return false;
  }
}

/**
 * Read the kortix-master process's currently-loaded KORTIX_TOKEN by
 * cat-ing `/workspace/.secrets/.bootstrap-env.json` from inside the
 * container. This is the source of truth for what the running process
 * actually accepts (bootstrap-env.ts overrides process.env at startup
 * with whatever's in this file).
 */
function readContainerBootstrapKey(): string | null {
  try {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (config.DOCKER_HOST && !config.DOCKER_HOST.includes('://')) {
      env.DOCKER_HOST = `unix://${config.DOCKER_HOST}`;
    }
    const out = execSync(
      `docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} cat /workspace/.secrets/.bootstrap-env.json`,
      { timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'], env },
    ).toString('utf8');
    const json = JSON.parse(out);
    return typeof json.KORTIX_TOKEN === 'string' && json.KORTIX_TOKEN.length > 0 ? json.KORTIX_TOKEN : null;
  } catch {
    return null;
  }
}

/**
 * Push a corrected serviceKey back into the sandboxes table so the
 * provider cache can refresh and future requests use the right value
 * without another 401 → docker exec round-trip.
 */
async function updateSandboxServiceKeyInDb(newKey: string): Promise<void> {
  try {
    const { db } = await import('../../shared/db');
    const { sandboxes } = await import('@kortix/db');
    const { eq, sql } = await import('drizzle-orm');
    await db
      .update(sandboxes)
      .set({ config: sql`jsonb_set(config, '{serviceKey}', ${JSON.stringify(newKey)}::jsonb)` as any })
      .where(eq(sandboxes.externalId, config.SANDBOX_CONTAINER_NAME));
    invalidateProviderCache(config.SANDBOX_CONTAINER_NAME);
    console.log('[LOCAL-PREVIEW] Refreshed sandbox serviceKey in DB + invalidated cache');
  } catch (err) {
    console.warn('[LOCAL-PREVIEW] Could not update sandbox serviceKey in DB:', (err as Error).message);
  }
}

const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'connection',
  'keep-alive',
  'te',
  'upgrade',
  'x-kortix-user-context',
]);

// Hop-by-hop response headers must not be forwarded by proxies.
// Passing these through while re-streaming can produce malformed chunked
// responses (for example ERR_INCOMPLETE_CHUNKED_ENCODING in browsers).
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

/**
 * Resolve the sandbox's Kortix Master URL.
 * Inside Docker: http://{sandboxId}:8000 (Docker DNS)
 * On host (pnpm dev): http://localhost:{SANDBOX_PORT_BASE}
 */
export function getSandboxBaseUrl(sandboxId: string): string {
  if (config.SANDBOX_NETWORK) {
    return `http://${sandboxId}:8000`;
  }
  return `http://localhost:${config.SANDBOX_PORT_BASE}`;
}

/**
 * Core proxy function — used by both Hono route handler and subdomain handler.
 * Exported so index.ts can call it directly for subdomain routing.
 */
export async function proxyToSandbox(
  sandboxId: string,
  port: number,
  method: string,
  path: string,
  queryString: string,
  incomingHeaders: Headers,
  incomingBody: ArrayBuffer | undefined,
  _acceptsSSE: boolean,
  origin: string,
  baseUrlOverride?: string,
  serviceKeyOverride?: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const sandboxBaseUrl = baseUrlOverride || getSandboxBaseUrl(sandboxId);
  const targetUrl = port === KORTIX_MASTER_PORT
    ? `${sandboxBaseUrl}${path}${queryString}`
    : `${sandboxBaseUrl}/proxy/${port}${path}${queryString}`;

  // Forward headers transparently
  const headers = new Headers();
  for (const [key, value] of incomingHeaders.entries()) {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set('Host', new URL(sandboxBaseUrl).host);
  const serviceKey = serviceKeyOverride || config.INTERNAL_SERVICE_KEY;
  if (serviceKey) {
    headers.set('Authorization', `Bearer ${serviceKey}`);
  }
  // Tell the sandbox what the public proxy base URL is so it can set the
  // OpenAPI server URL correctly AND so static-web's <base href> resolves
  // sub-resources back through the same public origin.
  //
  // Default = path-based routing: `${proto}://${host}/v1/p/${sandboxId}/${port}`.
  // Callers in subdomain mode (apps/api/src/index.ts subdomain handler)
  // override this via `extraHeaders` because subdomain URLs have no path
  // prefix — the subdomain itself encodes the routing.
  const originalHost = incomingHeaders.get('host');
  if (originalHost) {
    const proto = incomingHeaders.get('x-forwarded-proto') || 'http';
    headers.set('X-Forwarded-Prefix', `${proto}://${originalHost}/v1/p/${sandboxId}/${port}`);
    headers.set('X-Forwarded-Proto', proto);
    headers.set('X-Forwarded-Host', originalHost);
  }

  // extraHeaders applied last so callers can override defaults like
  // X-Forwarded-Prefix.
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value);
    }
  }

  // Abort handling — connection timeout only.
  // The timer fires if the upstream doesn't return headers within FETCH_TIMEOUT_MS.
  // Once headers arrive (fetch resolves), the timer is cleared so SSE / long-lived
  // streams are never killed by the proxy timeout — regardless of whether the client
  // sent Accept: text/event-stream (the OpenCode SDK doesn't).
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method,
      headers,
      body: incomingBody,
      signal: controller.signal,
      // @ts-ignore — Bun extension: no decompression, raw byte passthrough
      decompress: false,
      redirect: 'manual',
    });
  } catch (err: any) {
    clearTimeout(connectTimer);
    // Bun throws "Unable to connect. Is the computer able to access the url?"
    // when the target port isn't listening (ECONNREFUSED). This is expected
    // during sandbox startup — return a proper 503 instead of letting it
    // propagate as an unhandled 500 + Sentry spike.
    const msg = err?.message || String(err);
    const isConnectionError =
      msg.includes('Unable to connect') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNRESET') ||
      msg.includes('Is the computer able to access the url');
    if (isConnectionError) {
      console.warn(`[PREVIEW] Sandbox ${sandboxId}:${port} not reachable on ${method} ${path}: ${msg}`);
      const errHeaders = new Headers();
      if (origin) {
        errHeaders.set('Access-Control-Allow-Origin', origin);
        errHeaders.set('Access-Control-Allow-Credentials', 'true');
      }
      return new Response(
        JSON.stringify({ error: true, message: 'Sandbox is starting up. Please retry in a few seconds.', status: 503 }),
        { status: 503, headers: errHeaders },
      );
    }
    // Non-connection errors (abort, DNS, etc.) — re-throw to Hono error handler
    throw err;
  }

  // Headers received — clear the connection timeout.
  // The response body (potentially an SSE stream) continues flowing untouched.
  clearTimeout(connectTimer);

  function sanitizeResponseHeaders(input: Headers): Headers {
    const out = new Headers(input);
    for (const key of STRIP_RESPONSE_HEADERS) out.delete(key);
    return out;
  }

  // On 401 from sandbox: service-key mismatch. Two failure modes:
  //   (a) Container env files have key X but our cached serviceKey is Y.
  //       Pushing Y into the s6 env via trySyncServiceKey only helps the
  //       NEXT process spawn, not the currently-running kortix-master that
  //       loaded X at start. So syncing+retrying with the same Y still 401s.
  //   (b) The DB / our cache is fine but bootstrap-env.ts inside the
  //       container loaded an older KORTIX_TOKEN from a stale persistent
  //       /workspace/.secrets/.bootstrap-env.json.
  //
  // The container's bootstrap file is the source of truth for what the
  // running kortix-master process actually accepts. On 401, read that
  // file via `docker exec` and retry with whatever it says. If the retry
  // succeeds we also publish the corrected key into our DB row so
  // subsequent cache reads pick it up cleanly.
  if (response.status === 401 && !baseUrlOverride) {
    const containerKey = readContainerBootstrapKey();
    if (containerKey && containerKey !== serviceKey) {
      console.log('[LOCAL-PREVIEW] 401 — retrying with container bootstrap key');
      const retryHeaders = new Headers(headers);
      retryHeaders.set('Authorization', `Bearer ${containerKey}`);
      const retryController = new AbortController();
      const retryTimer = setTimeout(() => retryController.abort(), FETCH_TIMEOUT_MS);
      const retryResponse = await fetch(targetUrl, {
        method,
        headers: retryHeaders,
        body: incomingBody,
        signal: retryController.signal,
        // @ts-ignore
        decompress: false,
        redirect: 'manual',
      });
      clearTimeout(retryTimer);
      if (retryResponse.status !== 401) {
        // Retry succeeded — push the working key back into the DB +
        // invalidate the provider cache so subsequent requests use it.
        void updateSandboxServiceKeyInDb(containerKey).catch(() => {});
      }
      const out = sanitizeResponseHeaders(retryResponse.headers);
      if (origin) {
        out.set('Access-Control-Allow-Origin', origin);
        out.set('Access-Control-Allow-Credentials', 'true');
      }
      return new Response(retryResponse.body, {
        status: retryResponse.status,
        statusText: retryResponse.statusText,
        headers: out,
      });
    }
    // Fall back to the original docker-exec sync path if we couldn't read
    // the container's bootstrap file (e.g. file missing on cloud sandboxes).
    const synced = trySyncServiceKey(serviceKey);
    if (synced) {
      const retryController = new AbortController();
      const retryTimer = setTimeout(() => retryController.abort(), FETCH_TIMEOUT_MS);
      const retryResponse = await fetch(targetUrl, {
        method,
        headers,
        body: incomingBody,
        signal: retryController.signal,
        // @ts-ignore
        decompress: false,
        redirect: 'manual',
      });
      clearTimeout(retryTimer);
      const retryHeaders = sanitizeResponseHeaders(retryResponse.headers);
      if (origin) {
        retryHeaders.set('Access-Control-Allow-Origin', origin);
        retryHeaders.set('Access-Control-Allow-Credentials', 'true');
      }
      return new Response(retryResponse.body, {
        status: retryResponse.status,
        statusText: retryResponse.statusText,
        headers: retryHeaders,
      });
    }
  }

  // Log upstream 5xx errors so they're visible (not silently proxied through).
  // Skip for SSE responses — their body streams indefinitely and can't be cloned/consumed.
  const isSSEResponse = (response.headers.get('content-type') || '').includes('text/event-stream');
  if (response.status >= 500 && !isSSEResponse) {
    // Clone the response to peek at the body without consuming it
    try {
      const cloned = response.clone();
      const text = await cloned.text();
      const snippet = text.slice(0, 300);
      // Try JSON first
      try {
        const parsed = JSON.parse(snippet);
        const errMsg = parsed?.data?.message || parsed?.message || parsed?.error || snippet.slice(0, 150);
        const log = isExpectedStartupPreview(path, response.status, errMsg) ? console.warn : console.error;
        log(`[PREVIEW] Sandbox ${response.status} on ${method} ${path} (port ${port}): ${errMsg}`);
      } catch {
        if (snippet.includes('__bunfallback') || snippet.includes('BunError')) {
          console.error(`[PREVIEW] Sandbox ${response.status} on ${method} ${path} (port ${port}): Bun crash/module error (check sandbox logs)`);
        } else {
          const log = isExpectedStartupPreview(path, response.status, snippet) ? console.warn : console.error;
          log(`[PREVIEW] Sandbox ${response.status} on ${method} ${path} (port ${port}): ${snippet || '(empty)'}`);
        }
      }
    } catch {
      const log = isExpectedStartupPreview(path, response.status, '') ? console.warn : console.error;
      log(`[PREVIEW] Sandbox ${response.status} on ${method} ${path} (port ${port})`);
    }
  }

  // Stream response 1:1, only add CORS + fix redirects
  const respHeaders = sanitizeResponseHeaders(response.headers);
  if (origin) {
    respHeaders.set('Access-Control-Allow-Origin', origin);
    respHeaders.set('Access-Control-Allow-Credentials', 'true');
  }

  // Fix Location header for redirects.
  // Kortix Master's proxy rewrites e.g. http://localhost:5173/path → /proxy/5173/path.
  // For subdomain routing (p5173-sandbox.localhost:8008), the client already "is" at
  // the right port — strip the /proxy/{port} prefix so the redirect is just /path.
  // For path-based routing (OpenCode API at port 8000), there's no /proxy/ prefix, so
  // this is a no-op.
  const location = respHeaders.get('location');
  if (location && port !== KORTIX_MASTER_PORT) {
    const proxyPrefix = `/proxy/${port}`;
    if (location.startsWith(proxyPrefix)) {
      respHeaders.set('location', location.slice(proxyPrefix.length) || '/');
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: respHeaders,
  });
}

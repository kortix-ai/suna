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
// Ensures the running sandbox container has the canonical auth bundle from the DB.
// Triggered on first 401 from the sandbox (auth drift after startup/restart).
// Retries up to MAX_SYNC_ATTEMPTS on failure before giving up.
const MAX_SYNC_ATTEMPTS = 3;
let _syncAttempts = 0;
let _serviceKeySynced = false;

function trySyncServiceKey(serviceKey: string): boolean {
  if (_serviceKeySynced) return false;
  if (_syncAttempts >= MAX_SYNC_ATTEMPTS) {
    console.error(`[LOCAL-PREVIEW] Sandbox auth sync failed after ${MAX_SYNC_ATTEMPTS} attempts, giving up`);
    return false;
  }
  _syncAttempts++;
  try {
    if (!serviceKey) return false;

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (config.DOCKER_HOST && !config.DOCKER_HOST.includes('://')) {
      env.DOCKER_HOST = `unix://${config.DOCKER_HOST}`;
    }

    console.log(`[LOCAL-PREVIEW] Syncing sandbox auth bundle to container (attempt ${_syncAttempts}/${MAX_SYNC_ATTEMPTS})...`);
    execSync(
      `docker exec ${shellQuote(config.SANDBOX_CONTAINER_NAME)} bash -c ${shellQuote(buildCanonicalSandboxAuthCommand(serviceKey, config.KORTIX_URL.replace(/\/v1\/router\/?$/, '') || `http://host.docker.internal:${config.PORT}`))}`,
      { timeout: 15_000, stdio: 'pipe', env },
    );
    _serviceKeySynced = true;
    console.log('[LOCAL-PREVIEW] Sandbox auth bundle synced');
    return true;
  } catch (err: any) {
    console.error(`[LOCAL-PREVIEW] Failed to sync sandbox auth bundle (attempt ${_syncAttempts}/${MAX_SYNC_ATTEMPTS}):`, err.message || err);
    // Don't set _serviceKeySynced — allow retry on next 401
    return false;
  }
}

const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'connection',
  'keep-alive',
  'te',
  'upgrade',
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

  const response = await fetch(targetUrl, {
    method,
    headers,
    body: incomingBody,
    signal: controller.signal,
    // @ts-ignore — Bun extension: no decompression, raw byte passthrough
    decompress: false,
    redirect: 'manual',
  });

  // Headers received — clear the connection timeout.
  // The response body (potentially an SSE stream) continues flowing untouched.
  clearTimeout(connectTimer);

  function sanitizeResponseHeaders(input: Headers): Headers {
    const out = new Headers(input);
    for (const key of STRIP_RESPONSE_HEADERS) out.delete(key);
    return out;
  }

  // On 401 from sandbox: service key mismatch. Sync our key and retry once.
  // Only attempt local docker exec sync for local_docker provider (no baseUrlOverride).
  if (response.status === 401 && !_serviceKeySynced && !baseUrlOverride) {
    const synced = trySyncServiceKey(serviceKey);
    if (synced) {
      // Retry the request with the same key (now the sandbox should accept it)
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

import { type Kortix, type KortixPlatformConfig, createKortix } from '@kortix/sdk';
import { runWithKortix } from '@kortix/sdk/server';

import type { Auth } from './auth.ts';
import { openKortixWebSocket } from './kortix-socket.ts';
import { sdkBackendUrl } from '@kortix/shared/host-config';

export { sdkBackendUrl } from '@kortix/shared/host-config';

/**
 * The CLI's ONE seam onto `@kortix/sdk`. Every Kortix backend call the CLI
 * makes resolves its transport here — there is no other. `scripts/sdk-boundary.mjs`
 * exempts exactly this file from the raw-fetch rule and asserts the exemption
 * list has length 1, so a second escape hatch cannot be added quietly.
 */

export function sdkConfigFromAuth(auth: Auth): KortixPlatformConfig {
  const token = auth.token;
  return {
    backendUrl: sdkBackendUrl(auth.api_base),
    getToken: async () => token || null,
    // Baked by the release build (`--define`); `dev` in a local `bun run`. The
    // API names a CLI-created session's source from it (KRTX-2914).
    clientVersion: `cli/${process.env.KORTIX_CLI_VERSION ?? 'dev'}`,
  };
}

const clients = new Map<string, Kortix>();

function clientKey(auth: Auth): string {
  return `${sdkBackendUrl(auth.api_base)}\u0000${auth.token}`;
}

/**
 * The Kortix client for a host. Memoized per (backend url, token) so a CLI
 * process holds one client per host it actually talks to, not one per command
 * helper that happens to need a read.
 */
export function kortixFromAuth(auth: Auth): Kortix {
  const key = clientKey(auth);
  const existing = clients.get(key);
  if (existing) return existing;
  const created = createKortix(sdkConfigFromAuth(auth));
  clients.set(key, created);
  return created;
}

/**
 * Run `fn` with this host's config bound to the SDK's `AsyncLocalStorage`
 * scope. The process-global `configureKortix` singleton is documented as safe
 * for a CLI, but the CLI is genuinely multi-host: `locateSessionAnywhere`
 * scans every logged-in host, and `mapLimit` fans out concurrent reads. The
 * last writer to the global would win for every in-flight call, so every
 * backend call is scoped instead of racing a shared global.
 */
export function withKortixScope<T>(auth: Auth, fn: () => Promise<T>): Promise<T> {
  return runWithKortix(sdkConfigFromAuth(auth), fn);
}

export interface RunningSandboxPortProxy {
  url: string;
  close(): void;
}

interface StartSandboxPortProxyOpts {
  runtimeUrl: string;
  token: string;
  /** Read for every request and WebSocket upgrade; falls back to `token`. A
   *  proxy lives as long as `opencode attach`, longer than one credential. */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  port?: number;
}

interface ProxyWsData {
  upstreamUrl: string;
  upstream?: WebSocket;
  ready?: boolean;
  queue?: Array<string | Buffer | ArrayBuffer | Uint8Array>;
}

/**
 * Expose one SDK-resolved sandbox port (any `/p/{externalId}/{port}` proxy
 * route — OpenCode on 8000 for `opencode attach`, or an arbitrary dev-server
 * port for `sessions forward` / the TUI Ports panel) on localhost, injecting
 * the Kortix bearer token. This adapter owns the only raw HTTP/WebSocket
 * transport allowed in the CLI. `startSandboxPortProxy` below is this same
 * function under its established name at the one call site that predates the
 * generalization.
 */
export function startSandboxPortProxy(opts: StartSandboxPortProxyOpts): RunningSandboxPortProxy {
  const baseHttp = opts.runtimeUrl.replace(/\/+$/, '');
  const baseWs = baseHttp.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');

  const server = Bun.serve<ProxyWsData>({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    // Bun's default 10s idleTimeout severs exactly the connections the TUI
    // depends on: the idle global SSE event stream and long-blocking sends.
    idleTimeout: 0,
    fetch: async (req, bunServer) => {
      const incoming = new URL(req.url);
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const upstream = new URL(`${baseWs}${incoming.pathname}${incoming.search}`);
        upstream.searchParams.set('token', (await opts.getToken?.()) || opts.token);
        const upgraded = bunServer.upgrade(req, {
          data: { upstreamUrl: upstream.toString() },
        });
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
      }

      const upstream = `${baseHttp}${incoming.pathname}${incoming.search}`;
      return forwardProxiedHttp(req, upstream, (await opts.getToken?.()) || opts.token);
    },
    websocket: {
      open(ws) {
        ws.data.queue = [];
        ws.data.ready = false;
        let upstream: WebSocket;
        try {
          upstream = openKortixWebSocket(ws.data.upstreamUrl);
        } catch {
          try {
            ws.close(1011, 'upstream connect failed');
          } catch {}
          return;
        }
        upstream.binaryType = 'arraybuffer';
        ws.data.upstream = upstream;

        upstream.onopen = () => {
          ws.data.ready = true;
          const queued = ws.data.queue ?? [];
          ws.data.queue = [];
          for (const message of queued) {
            try {
              upstream.send(message as never);
            } catch {}
          }
        };
        upstream.onmessage = (event: MessageEvent) => {
          try {
            ws.send(event.data as never);
          } catch {}
        };
        upstream.onclose = (event: CloseEvent) => {
          try {
            ws.close(sanitizeCloseCode(event.code), (event.reason || '').slice(0, 120));
          } catch {}
        };
        upstream.onerror = () => {
          try {
            ws.close(1011, 'upstream error');
          } catch {}
        };
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        if (ws.data.ready && upstream?.readyState === WebSocket.OPEN) {
          try {
            upstream.send(message as never);
          } catch {}
        } else {
          const queue = ws.data.queue ?? [];
          ws.data.queue = queue;
          queue.push(message);
        }
      },
      close(ws) {
        try {
          ws.data.upstream?.close();
        } catch {}
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}

async function forwardProxiedHttp(
  request: Request,
  upstream: string,
  token: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');

  let response: Response;
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });
  } catch (error) {
    return new Response(`Sandbox proxy upstream error: ${(error as Error).message}`, {
      status: 502,
    });
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function sanitizeCloseCode(code: number | undefined): number {
  if (typeof code !== 'number') return 1000;
  if (code === 1000) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

/**
 * A request to the sandbox daemon on this machine (`kortix chrome` inside a
 * session). The daemon is not the Kortix API, so it has no SDK client.
 */
export async function sandboxDaemonRequest(
  base: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text() };
}

/** Public device bootstrap cannot use the authenticated SDK transport: there
 * is deliberately no credential until approval. Keep it in the transport seam. */
export async function cliDeviceRequest<T>(apiBase: string, path: 'start' | 'poll', body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${sdkBackendUrl(apiBase)}/cli/device/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kortix-Client-Version': 'cli/dev' },
    body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error(`Device login failed (HTTP ${response.status}). Retry or use kortix login --token <key>.`);
  return await response.json() as T;
}

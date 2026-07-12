import { spawn } from 'node:child_process';

import { OPENCODE_PORT } from '../api/sandbox-proxy.ts';
import { takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';
import {
  ensureOpencodeSession,
  loadOpenCodeSession,
  resolveRunningSessionId,
} from './sessions-chat.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const CONNECT_HELP = help`Usage: kortix sessions connect [<session-id>] [options] [-- <opencode attach args…>]

Attach your local OpenCode TUI to the OpenCode server already running inside a
Kortix session sandbox. The CLI opens a local loopback proxy, injects your
Kortix auth token, then runs \`opencode attach\` against it.

Given a session id, resolves the right host/project on its own: tries the
active/linked project first, then — unless you pin --host/--project — scans
every logged-in host and account for the id. One command, no manual
\`kortix projects use\` / \`kortix hosts use\` first.

  --port <N>       Local loopback proxy port (default: random free port).
  --project <id>   Pin this project id (skips the cross-host scan).
  --host <name>    Pin this Kortix host (skips the cross-host scan).
  -h, --help       Show this help.

Examples:
  kortix sessions connect <session-id>
  kortix sessions connect <session-id> -- --mini
  kortix sessions connect --port 4100 <session-id>`;

export async function runSessionsConnect(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${CONNECT_HELP}\n`);
    return 0;
  }

  const separator = rest.indexOf('--');
  const attachArgs = separator >= 0 ? rest.splice(separator + 1) : [];
  if (separator >= 0) rest.splice(separator);

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let portRaw: string | undefined;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    portRaw = takeFlagValue(rest, ['--port']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) {
    process.stderr.write(`${status.err('Pass at most one session id.')}\n`);
    return 2;
  }
  const proxyPort = parseConnectPort(portRaw);
  if (proxyPort === null) return 2;

  const opts: CtxOpts = { projectArg, hostArg };
  const sessionId = await resolveRunningSessionId(positional[0], opts, 'Pick a session to connect to');
  if (!sessionId) return 1;

  // A session id may belong to a different project (or host) than the one
  // currently active/linked — loadOpenCodeSession locates it on its own
  // (--project/--host still pin it) instead of surfacing a bare "Not found".
  const resolved = await loadOpenCodeSession(sessionId, opts, 'sessions connect');
  if (!resolved) return 1;
  const ocSessionId = await ensureOpencodeSession(resolved);
  if (!ocSessionId) return 1;

  let proxy: RunningOpenCodeProxy;
  try {
    proxy = startOpenCodeProxy({
      apiBase: resolved.auth.api_base,
      token: resolved.auth.token,
      sandboxId: resolved.proxyId,
      port: proxyPort,
    });
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }

  const label = resolved.session.name ?? resolved.session.session_id.split('-')[0];
  const attachCommand = buildAttachArgs(proxy.url, ocSessionId, attachArgs);
  process.stderr.write(
    `${status.ok(`Connecting to ${C.bold}${label}${C.reset}`)} ` +
      `${C.dim}(OpenCode ${ocSessionId}, local ${proxy.url})${C.reset}\n`,
  );

  try {
    return await spawnOpenCodeAttach(attachCommand);
  } finally {
    proxy.close();
  }
}

function parseConnectPort(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`${status.err('--port must be 0-65535.')}\n`);
    return null;
  }
  return port;
}

interface RunningOpenCodeProxy {
  url: string;
  close(): void;
}

interface StartOpenCodeProxyOpts {
  apiBase: string;
  token: string;
  sandboxId: string;
  port?: number;
}

interface ProxyWsData {
  upstreamUrl: string;
  upstream?: WebSocket;
  ready?: boolean;
  queue?: Array<string | Buffer | ArrayBuffer | Uint8Array>;
}

/**
 * Expose the sandbox OpenCode API on localhost so `opencode attach` can use its
 * normal SDK client. The remote API requires Kortix Bearer auth and lives behind
 * `/v1/p/{sandbox}/{4096}`; this proxy hides both details from OpenCode.
 */
export function startOpenCodeProxy(opts: StartOpenCodeProxyOpts): RunningOpenCodeProxy {
  const baseHttp = buildProxyBase(opts.apiBase, opts.sandboxId);
  const baseWs = baseHttp.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');

  const server = Bun.serve<ProxyWsData>({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    fetch: async (req, bunServer) => {
      const incoming = new URL(req.url);
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const upstream = new URL(`${baseWs}${incoming.pathname}${incoming.search}`);
        upstream.searchParams.set('token', opts.token);
        const upgraded = bunServer.upgrade(req, {
          data: { upstreamUrl: upstream.toString() },
        });
        return upgraded
          ? undefined
          : new Response('WebSocket upgrade failed', { status: 500 });
      }

      const upstream = `${baseHttp}${incoming.pathname}${incoming.search}`;
      return forwardOpenCodeHttp(req, upstream, opts.token);
    },
    websocket: {
      open(ws) {
        ws.data.queue = [];
        ws.data.ready = false;
        let upstream: WebSocket;
        try {
          upstream = new WebSocket(ws.data.upstreamUrl);
        } catch {
          try { ws.close(1011, 'upstream connect failed'); } catch {}
          return;
        }
        upstream.binaryType = 'arraybuffer';
        ws.data.upstream = upstream;

        upstream.onopen = () => {
          ws.data.ready = true;
          const queued = ws.data.queue ?? [];
          ws.data.queue = [];
          for (const msg of queued) {
            try { upstream.send(msg as any); } catch {}
          }
        };
        upstream.onmessage = (event: MessageEvent) => {
          try { ws.send(event.data as any); } catch {}
        };
        upstream.onclose = (event: CloseEvent) => {
          try { ws.close(sanitizeCloseCode(event.code), (event.reason || '').slice(0, 120)); } catch {}
        };
        upstream.onerror = () => {
          try { ws.close(1011, 'upstream error'); } catch {}
        };
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        if (ws.data.ready && upstream?.readyState === WebSocket.OPEN) {
          try { upstream.send(message as any); } catch {}
        } else {
          (ws.data.queue ??= []).push(message);
        }
      },
      close(ws) {
        try { ws.data.upstream?.close(); } catch {}
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}

async function forwardOpenCodeHttp(
  req: Request,
  upstream: string,
  token: string,
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');

  let res: Response;
  try {
    res = await fetch(upstream, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
    });
  } catch (err) {
    return new Response(`OpenCode proxy upstream error: ${(err as Error).message}`, {
      status: 502,
    });
  }

  const responseHeaders = new Headers(res.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
  });
}

function buildProxyBase(apiBase: string, sandboxId: string): string {
  const base = apiBase.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/p/${encodeURIComponent(sandboxId)}/${OPENCODE_PORT}`;
}

function buildAttachArgs(
  url: string,
  opencodeSessionId: string,
  extraArgs: string[],
): string[] {
  const hasContinuation = extraArgs.some(
    (arg) => arg === '--session' || arg === '-s' || arg.startsWith('--session=') || arg === '--continue' || arg === '-c',
  );
  return [
    'attach',
    url,
    ...(hasContinuation ? [] : ['--session', opencodeSessionId]),
    ...extraArgs,
  ];
}

function spawnOpenCodeAttach(args: string[]): Promise<number> {
  const bin = process.env.KORTIX_OPENCODE_BIN || 'opencode';
  const child = spawn(bin, args, { stdio: 'inherit' });
  return new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(
        `${status.err(`Could not run ${bin}: ${err.message}`)}\n` +
          `  ${C.dim}Install OpenCode or set KORTIX_OPENCODE_BIN.${C.reset}\n`,
      );
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') resolve(code);
      else resolve(signal ? 130 : 1);
    });
  });
}

function sanitizeCloseCode(code: number | undefined): number {
  if (typeof code !== 'number') return 1000;
  if (code === 1000) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

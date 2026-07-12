import type { Auth } from './auth.ts';
import { ApiError } from './client.ts';

/** Kortix's harness-neutral sandbox daemon port. */
export const KORTIX_DAEMON_PORT = 8000;

interface RequestOpts {
  apiBase: string;
  token: string;
  sandboxId: string;
  port: number;
  path: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Per-request timeout. OpenCode prompt calls block for the AI to finish,
   *  so callers can override to e.g. 5 minutes. */
  timeoutMs?: number;
}

function joinProxyUrl(opts: RequestOpts): string {
  const base = opts.apiBase.replace(/\/+$/, '');
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`,
        )
        .join('&')
    : '';
  return `${base}/v1/p/${opts.sandboxId}/${opts.port}${path}${qs ? `?${qs}` : ''}`;
}

/**
 * Make an HTTP call against a sandbox service through the Kortix proxy.
 * Used for talking to OpenCode (port 4096) from the CLI.
 */
export async function sandboxRequest<T>(opts: RequestOpts): Promise<T> {
  const url = joinProxyUrl(opts);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, `sandbox request timed out after ${timeoutMs}ms`);
    }
    throw new ApiError(0, `network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof payload === 'object' && payload && 'error' in payload && typeof (payload as { error: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : typeof payload === 'object' && payload && 'message' in payload && typeof (payload as { message: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, payload);
  }
  return payload as T;
}

/** Build the WebSocket URL for a raw terminal (PTY) session, mirroring what
 *  the web app's browser client connects to — same host, same `?token=`
 *  query auth (WebSocket can't set custom headers). Reaches Kortix's own
 *  `/kortix/pty` implementation in the sandbox daemon (routes/pty.ts),
 *  independent of whatever agent runtime (OpenCode today) is running — same
 *  daemon port, same proxy, same auth as everything else, just a different
 *  path than OpenCode's own (now-unused-by-the-CLI) `/pty`. */
export function kortixPtyWsUrl(auth: Auth, sandboxId: string, ptyId: string): string {
  const base = auth.api_base.replace(/\/+$/, '').replace(/\/v1$/, '');
  const httpBase = `${base}/v1/p/${encodeURIComponent(sandboxId)}/${KORTIX_DAEMON_PORT}`;
  const wsBase = httpBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/kortix/pty/${encodeURIComponent(ptyId)}/connect?token=${encodeURIComponent(auth.token)}`;
}

export interface SandboxRuntimeOpts {
  auth: Auth;
  sandboxId: string;
}

/**
 * Harness-neutral Kortix daemon helpers bound to a session runtime.
 */
export function sandboxRuntimeClient(opts: SandboxRuntimeOpts) {
  const { auth, sandboxId } = opts;
  const base = {
    apiBase: auth.api_base,
    token: auth.token,
    sandboxId,
    port: KORTIX_DAEMON_PORT,
  };
  return {
    listPty: () => sandboxRequest<KortixPty[]>({ ...base, path: '/kortix/pty' }),
    createPty: (body?: {
      command?: string;
      args?: string[];
      cwd?: string;
      title?: string;
      env?: Record<string, string>;
    }) =>
      sandboxRequest<KortixPty>({
        ...base,
        path: '/kortix/pty',
        method: 'POST',
        body: body ?? {},
      }),
    updatePty: (ptyId: string, body: { title?: string; size?: { rows: number; cols: number } }) =>
      sandboxRequest<KortixPty>({
        ...base,
        path: `/kortix/pty/${ptyId}`,
        method: 'PATCH',
        body,
      }),
    removePty: (ptyId: string) =>
      sandboxRequest<boolean>({
        ...base,
        path: `/kortix/pty/${ptyId}`,
        method: 'DELETE',
      }),
  };
}

/** A raw terminal (PTY) running inside the sandbox — Kortix's own
 *  implementation (routes/pty.ts in the sandbox daemon), independent of
 *  whatever agent runtime is running. Same shape the web app's terminal
 *  panel binds to. */
export interface KortixPty {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
  exitCode?: number;
}

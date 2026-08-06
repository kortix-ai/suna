import { CliError } from './cli';

const TIMEOUT_MS = 30_000;

function apiBase(): string {
  const url = process.env.KORTIX_API_URL?.trim();
  if (!url) {
    throw new CliError(
      'KORTIX_API_URL not set — apps/api is unreachable from this sandbox.',
      'MISSING_ENV',
    );
  }
  return url.replace(/\/$/, '');
}

function authHeaders(): Record<string, string> {
  const token = (process.env.KORTIX_CLI_TOKEN || '').trim();
  if (!token) {
    throw new CliError(
      'KORTIX_CLI_TOKEN not set — cannot authenticate to apps/api.',
      'MISSING_ENV',
    );
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function buildUrl(path: string, params?: Record<string, string>): string {
  const base = apiBase();
  const versioned = path.startsWith('/v1/') ? path : `/v1${path.startsWith('/') ? path : `/${path}`}`;
  const url = new URL(versioned, base);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function kortixGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const res = await fetch(buildUrl(path, params), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseResponse<T>(res);
}

export async function kortixPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(buildUrl(path), {
    method: 'POST',
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseResponse<T>(res);
}

export async function kortixDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(buildUrl(path), {
    method: 'DELETE',
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseResponse<T>(res);
}

/**
 * Run one connector action through the compiled Kortix CLI. The CLI owns the
 * `@kortix/sdk` client and token seam. Runtime shims do not carry SDK source or
 * a second gateway client.
 */
export async function kortixConnectorCall<T = unknown>(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const executable = process.env.KORTIX_CLI_BIN?.trim() || 'kortix';
  const command = executable.endsWith('.ts')
    ? [process.execPath, executable, 'connectors', 'call', tool, JSON.stringify(args)]
    : [executable, 'connectors', 'call', tool, JSON.stringify(args)];
  const proc = Bun.spawn({
    cmd: command,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let body: unknown = undefined;
  if (stdout.trim()) {
    try {
      body = JSON.parse(stdout.trim());
    } catch {
      body = stdout.trim();
    }
  }
  if (exitCode !== 0) {
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : stderr.trim() || stdout.trim() || `kortix connectors call exited ${exitCode}`;
    throw new CliError(message, 'CONNECTOR_ERROR', exitCode || 1);
  }
  return body as T;
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message = (body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : text || res.statusText) || `HTTP ${res.status}`;
    throw new CliError(message, 'API_ERROR', 1);
  }
  return body as T;
}

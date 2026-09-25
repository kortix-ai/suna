import { CliError } from './cli';

const TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

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
  const token = (process.env.KORTIX_TOKEN || '').trim();
  if (!token) {
    throw new CliError(
      'KORTIX_TOKEN not set — cannot authenticate to apps/api.',
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
 * GET a binary body (a file proxied by apps/api, so provider tokens stay on the
 * server). A failed response throws the same readable `API_ERROR` as the JSON
 * helpers, prefixed with `Download failed:`.
 */
export async function kortixDownload(
  path: string,
  params?: Record<string, string>,
): Promise<ArrayBuffer> {
  const res = await fetch(buildUrl(path, params), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw apiError(res, await res.text(), 'Download failed: ');
  return res.arrayBuffer();
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

/**
 * The readable reason of a failed apps/api response. The API's structured
 * denial is `{ error: true, message, code, action }` (apps/api/src/iam/
 * denial-message.ts): `error` is a boolean flag and the text is in `message`.
 * Order: string `message`, string `error`, raw body, status text, `HTTP <status>`.
 */
export function apiErrorMessage(status: number, statusText: string, text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the raw text is the message.
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (typeof record.message === 'string' && record.message) return record.message;
  if (typeof record.error === 'string' && record.error) return record.error;
  return text || statusText || `HTTP ${status}`;
}

function apiError(res: Response, text: string, prefix = ''): CliError {
  const message = apiErrorMessage(res.status, res.statusText, text);
  return new CliError(`${prefix}HTTP ${res.status}: ${message}`, 'API_ERROR', 1, {
    status: res.status,
  });
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw apiError(res, text);
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return body as T;
}

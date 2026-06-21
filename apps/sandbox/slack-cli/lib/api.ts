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
  const token = (process.env.KORTIX_CLI_TOKEN || process.env.KORTIX_TOKEN || '').trim();
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

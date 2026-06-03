import type { Auth } from './auth.ts';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface ApiClient {
  apiBase: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

interface ClientOptions {
  apiBase?: string;
  token?: string;
}

function joinUrl(base: string, path: string): string {
  let b = base.endsWith('/') ? base.slice(0, -1) : base;
  // The base may or may not already carry the `/v1` mount. Host login stores a
  // bare origin (`https://api.kortix.com`); a session sandbox injects
  // `KORTIX_API_URL` *with* the suffix (`https://<tunnel>/v1`). Strip a trailing
  // `/v1` here so we add exactly one below — otherwise in-sandbox calls hit
  // `/v1/v1/projects/…` and 404 even with a valid token.
  if (b.endsWith('/v1')) b = b.slice(0, -3);
  const p = path.startsWith('/') ? path : `/${path}`;
  // Hono mounts v1 routes. Normalize incoming `/accounts/me` -> `/v1/accounts/me`.
  const versioned = p.startsWith('/v1/') ? p : `/v1${p}`;
  return `${b}${versioned}`;
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  opts: { apiBase: string; token?: string },
): Promise<T> {
  const url = joinUrl(opts.apiBase, path);
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, `network error: ${(err as Error).message}`);
  }

  let payload: unknown = null;
  const text = await res.text();
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

export function createApiClient(opts: ClientOptions): ApiClient {
  const apiBase = opts.apiBase ?? 'https://api.kortix.com';
  return {
    apiBase,
    get: <T>(path: string) => request<T>('GET', path, undefined, { apiBase, token: opts.token }),
    post: <T>(path: string, body?: unknown) =>
      request<T>('POST', path, body ?? {}, { apiBase, token: opts.token }),
    put: <T>(path: string, body?: unknown) =>
      request<T>('PUT', path, body ?? {}, { apiBase, token: opts.token }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>('PATCH', path, body ?? {}, { apiBase, token: opts.token }),
    delete: <T>(path: string) => request<T>('DELETE', path, undefined, { apiBase, token: opts.token }),
  };
}

export function clientFromAuth(auth: Auth): ApiClient {
  return createApiClient({ apiBase: auth.api_base, token: auth.token });
}

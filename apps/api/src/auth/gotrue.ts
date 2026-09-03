/**
 * Server-side GoTrue (Supabase Auth) client for the headless `/v1/auth/*`
 * routes. The API calls Supabase with its own key and forwards the caller's
 * IP, so a client never needs a Supabase URL or anon key — the Kortix API is
 * the only thing it talks to, on kortix.com and on every self-host alike.
 *
 * Every function returns `{ ok, status, body }` instead of throwing: the
 * routes pass GoTrue's status and `{error, error_description}` through
 * unchanged, so a wrong password is a 400 from Supabase, not a 500 from us.
 */
import { config } from '../config';

export type GoTrueFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface GoTrueSession {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
}

export interface GoTrueUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  created_at?: string;
  last_sign_in_at?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GoTrueResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  body: T & { error?: string; error_description?: string };
}

let fetchImpl: GoTrueFetch = (input, init) => fetch(input, init);
/** @internal test seam */
export function __setGoTrueFetch(next: GoTrueFetch | null): void {
  fetchImpl = next ?? ((input, init) => fetch(input, init));
}

function base(): string {
  return `${config.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;
}

/**
 * GoTrue answers errors in three shapes across versions:
 * `{error, error_description}`, `{code, msg}`, `{error_code, msg}`. Normalise
 * to the OAuth-style pair every client already understands.
 */
export function normalizeGoTrueError(status: number, raw: unknown): { error: string; error_description: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const error =
    (typeof r.error_code === 'string' && r.error_code) ||
    (typeof r.error === 'string' && r.error) ||
    (typeof r.code === 'string' && r.code) ||
    (status === 429 ? 'over_request_rate_limit' : 'auth_error');
  const description =
    (typeof r.error_description === 'string' && r.error_description) ||
    (typeof r.msg === 'string' && r.msg) ||
    (typeof r.message === 'string' && r.message) ||
    `Authentication request failed (${status})`;
  return { error, error_description: description };
}

export async function gotrue<T = Record<string, unknown>>(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    bearer?: string | null;
    clientIp?: string | null;
    query?: Record<string, string | undefined>;
  } = {},
): Promise<GoTrueResult<T>> {
  const url = new URL(`${base()}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    apikey: config.SUPABASE_SERVICE_ROLE_KEY,
    accept: 'application/json',
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  // The caller's identity for GoTrue: its own bearer for /user, /logout, PUT
  // /user — NEVER the service key (that would make every call an admin call).
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.clientIp) headers['x-forwarded-for'] = init.clientIp;
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'manual',
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      body: { error: 'auth_upstream_unreachable', error_description: (err as Error).message } as GoTrueResult<T>['body'],
    };
  }
  const text = await res.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (res.ok) return { ok: true, status: res.status, body: (parsed ?? {}) as GoTrueResult<T>['body'] };
  return { ok: false, status: res.status, body: normalizeGoTrueError(res.status, parsed) as GoTrueResult<T>['body'] };
}

/** GoTrue's `/authorize` answers a 302 to the provider; we hand the client that URL. */
export async function gotrueAuthorizeUrl(query: Record<string, string | undefined>): Promise<GoTrueResult<{ url: string }>> {
  const url = new URL(`${base()}/authorize`);
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { apikey: config.SUPABASE_SERVICE_ROLE_KEY, accept: 'application/json' },
      redirect: 'manual',
    });
  } catch (err) {
    return { ok: false, status: 502, body: { error: 'auth_upstream_unreachable', error_description: (err as Error).message } as never };
  }
  const location = res.headers.get('location');
  if ((res.status === 302 || res.status === 303 || res.status === 301) && location) {
    return { ok: true, status: 200, body: { url: location } };
  }
  const text = await res.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: false, status: res.ok ? 502 : res.status, body: normalizeGoTrueError(res.status, parsed) as never };
}

export function sessionFrom(body: Record<string, unknown>): GoTrueSession | null {
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') return null;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: typeof body.token_type === 'string' ? body.token_type : 'bearer',
    expires_in: expiresIn,
    expires_at: typeof body.expires_at === 'number' ? body.expires_at : Math.floor(Date.now() / 1000) + expiresIn,
  };
}

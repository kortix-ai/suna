/**
 * Supabase auth seam — the one place we drop below the Kortix API, used only to
 * create/confirm synthetic users and exchange password for a real JWT. Everything
 * else (accounts, members, policies, tokens) is provisioned through the Kortix API
 * so fixtures stay honest.
 *
 * Every call is time-bounded: a raw fetch with no timeout against an unreachable
 * or misconfigured KE2E_SUPABASE_URL hangs the whole run silently at world setup
 * (before any flow logs), so a hang must surface as a fast, clear failure instead.
 */
import type { Env } from "../core/env";
import { supabaseAdminHeaders } from "../core/supabase-admin";
import type { SupabaseGrant } from "./supabase-session";

const SUPABASE_TIMEOUT_MS = Number(process.env.KE2E_SUPABASE_TIMEOUT_MS ?? 15_000);

async function supaFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `Supabase request timed out after ${SUPABASE_TIMEOUT_MS}ms: ${url} — is KE2E_SUPABASE_URL reachable from CI?`,
      );
    }
    throw new Error(`Supabase request failed: ${url} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/** Validate a GoTrue token response. Never echoes the tokens themselves. */
function toGrant(data: TokenResponse, what: string): SupabaseGrant {
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error(`${what}: token response has no access_token`);
  }
  if (typeof data.refresh_token !== 'string' || !data.refresh_token) {
    throw new Error(`${what}: token response has no refresh_token`);
  }
  // GoTrue always sends expires_in; 3600 s is its default if a proxy strips it.
  const seconds = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresInMs: seconds * 1000 };
}

/** Exchange email + password for a full session (access + refresh token). */
export async function passwordGrantSession(env: Env, email: string, password: string): Promise<SupabaseGrant> {
  if (!env.supabaseAnonKey) throw new Error("KE2E_SUPABASE_ANON_KEY required for password grant");
  const res = await supaFetch(`${env.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.supabaseAnonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`password grant failed for ${email}: ${res.status} ${await res.text()}`);
  return toGrant((await res.json()) as TokenResponse, `password grant for ${email}`);
}

/** Exchange email + password for a one-shot access token (no renewal). */
export async function passwordGrant(env: Env, email: string, password: string): Promise<string> {
  return (await passwordGrantSession(env, email, password)).accessToken;
}

/**
 * Renew a session through the refresh-token grant. GoTrue rotates the refresh
 * token, so the caller must keep the new one. A network failure, a 429 or a
 * 5xx is marked `ke2eRetryable`; a 4xx means the session is gone.
 */
export async function refreshGrant(env: Env, refreshToken: string): Promise<SupabaseGrant> {
  if (!env.supabaseAnonKey) throw new Error("KE2E_SUPABASE_ANON_KEY required for refresh grant");
  let res: Response;
  try {
    res = await supaFetch(`${env.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: env.supabaseAnonKey, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { ke2eRetryable: true });
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw Object.assign(new Error(`refresh grant failed: ${res.status} ${body}`), {
      ke2eRetryable: res.status === 429 || res.status >= 500,
    });
  }
  return toGrant((await res.json()) as TokenResponse, 'refresh grant');
}

export interface AdminUser {
  id: string;
  email: string;
}

export async function ssoFixtureToken(
  env: Env,
  user: { userId?: string; email?: string },
  providerId: string,
  groups: string[],
): Promise<string> {
  if (!user.userId || !user.email || !env.supabaseServiceRoleKey) {
    throw new Error('SSO fixture requires a synthetic user and Supabase admin credentials');
  }
  const password = `Ke2e-${crypto.randomUUID()}-Aa1!`;
  const res = await supaFetch(`${env.supabaseUrl}/auth/v1/admin/users/${user.userId}`, {
    method: 'PUT',
    headers: supabaseAdminHeaders(env.supabaseServiceRoleKey, {
      anonKey: env.supabaseAnonKey ?? undefined,
      json: true,
    }),
    body: JSON.stringify({
      password,
      app_metadata: { sso_provider_id: providerId },
      user_metadata: { custom_claims: { memberOf: groups } },
    }),
  });
  if (!res.ok) throw new Error(`SSO fixture metadata update failed: ${res.status}`);
  return passwordGrant(env, user.email, password);
}

export async function adminCreateUser(env: Env, email: string, password: string): Promise<AdminUser> {
  if (!env.supabaseServiceRoleKey || !env.supabaseAnonKey) {
    throw new Error("Supabase service-role + anon keys required to create test users");
  }
  const res = await supaFetch(`${env.supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: supabaseAdminHeaders(env.supabaseServiceRoleKey, {
      anonKey: env.supabaseAnonKey ?? undefined,
      json: true,
    }),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`admin create user ${email} failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { id: string; email: string };
  return { id: data.id, email: data.email ?? email };
}

export async function adminDeleteUser(env: Env, userId: string): Promise<void> {
  if (!env.supabaseServiceRoleKey || !env.supabaseAnonKey) return;
  const res = await supaFetch(`${env.supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: supabaseAdminHeaders(env.supabaseServiceRoleKey, {
      anonKey: env.supabaseAnonKey ?? undefined,
    }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`admin delete user ${userId} failed: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
}

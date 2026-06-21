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

export async function passwordGrant(env: Env, email: string, password: string): Promise<string> {
  if (!env.supabaseAnonKey) throw new Error("KE2E_SUPABASE_ANON_KEY required for password grant");
  const res = await supaFetch(`${env.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.supabaseAnonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`password grant failed for ${email}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export interface AdminUser {
  id: string;
  email: string;
}

export async function adminCreateUser(env: Env, email: string, password: string): Promise<AdminUser> {
  if (!env.supabaseServiceRoleKey || !env.supabaseAnonKey) {
    throw new Error("Supabase service-role + anon keys required to create test users");
  }
  const res = await supaFetch(`${env.supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: env.supabaseAnonKey,
      authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "content-type": "application/json",
    },
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
    headers: {
      apikey: env.supabaseAnonKey,
      authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`admin delete user ${userId} failed: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
}

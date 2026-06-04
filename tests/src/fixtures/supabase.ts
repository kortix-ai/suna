/**
 * Supabase auth seam — the one place we drop below the Kortix API, used only to
 * create/confirm synthetic users and exchange password for a real JWT. Everything
 * else (accounts, members, policies, tokens) is provisioned through the Kortix API
 * so fixtures stay honest.
 */
import type { Env } from "../core/env";

export async function passwordGrant(env: Env, email: string, password: string): Promise<string> {
  if (!env.supabaseAnonKey) throw new Error("KE2E_SUPABASE_ANON_KEY required for password grant");
  const res = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=password`, {
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
  const res = await fetch(`${env.supabaseUrl}/auth/v1/admin/users`, {
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
  await fetch(`${env.supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: {
      apikey: env.supabaseAnonKey,
      authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    },
  }).catch(() => {});
}

/**
 * GC sweep. Every principal is a synthesized Supabase user under the test email
 * domain, so reclaiming those users (+ their cascade) is the primary leak guard.
 * Runs by email-domain prefix + age so it never touches an in-flight run.
 *
 * Uses the Supabase admin API (service-role). A DB/Daytona fallback for orphaned
 * sandboxes can be layered on later via KE2E_DATABASE_URL.
 */
import { loadEnv, type Env } from "../core/env";
import { log } from "../core/log";
import { adminDeleteUser } from "./supabase";

export interface GcOptions {
  olderThan: string; // e.g. "2h", "30m", "1d"
  dryRun: boolean;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)\s*([smhd])$/);
  if (!m) throw new Error(`bad --older-than "${s}" (use e.g. 30m, 2h, 1d)`);
  const n = Number(m[1]);
  return n * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as "s" | "m" | "h" | "d"];
}

interface SupaUser {
  id: string;
  email?: string;
  created_at?: string;
}

async function listTestUsers(env: Env): Promise<SupaUser[]> {
  const out: SupaUser[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: { apikey: env.supabaseAnonKey!, authorization: `Bearer ${env.supabaseServiceRoleKey!}` },
    });
    if (!res.ok) throw new Error(`admin list users failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { users?: SupaUser[] };
    const users = body.users ?? [];
    if (users.length === 0) break;
    out.push(...users);
    if (users.length < 200) break;
  }
  return out.filter((u) => (u.email ?? "").endsWith(`@${env.testEmailDomain}`));
}

export async function runGc(opts: GcOptions): Promise<void> {
  const env = loadEnv();
  if (!env.capabilities.supabaseAdmin || !env.supabaseAnonKey) {
    throw new Error("gc requires KE2E_SUPABASE_SERVICE_ROLE_KEY + KE2E_SUPABASE_ANON_KEY");
  }
  const cutoff = Date.now() - parseDuration(opts.olderThan);
  log.info(`gc: target=${env.target} domain=@${env.testEmailDomain} olderThan=${opts.olderThan} dryRun=${opts.dryRun}`);

  const users = await listTestUsers(env);
  const stale = users.filter((u) => {
    const created = u.created_at ? Date.parse(u.created_at) : 0;
    return created > 0 && created < cutoff;
  });

  log.info(`gc: ${users.length} test user(s) found, ${stale.length} older than ${opts.olderThan}`);
  let removed = 0;
  for (const u of stale) {
    if (opts.dryRun) {
      log.info(`  would delete ${u.email} (${u.id})`);
      continue;
    }
    await adminDeleteUser(env, u.id);
    removed++;
  }
  if (!opts.dryRun) log.pass(`gc: reclaimed ${removed} stale test user(s)`);
}

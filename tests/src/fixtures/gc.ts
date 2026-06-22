/**
 * GC sweep. Every principal is a synthesized Supabase user under the test email
 * domain, so reclaiming those users (+ their cascade) is the primary leak guard.
 * Runs by email-domain prefix + age so it never touches an in-flight run.
 *
 * Uses the Supabase admin API (service-role). A DB/Daytona fallback for orphaned
 * sandboxes can be layered on later via KE2E_DATABASE_URL.
 */
import { Client } from "../core/client";
import { loadEnv, type Env } from "../core/env";
import { log } from "../core/log";
import { adminDeleteUser, passwordGrant } from "./supabase";

const SYNTH_PASSWORD = "Ke2e-passw0rd-Aa1!";

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

async function listTestUsersViaApi(env: Env): Promise<SupaUser[]> {
  const out: SupaUser[] = [];
  for (let page = 1; page <= 100; page++) {
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
  return out;
}

async function listTestUsersViaDb(env: Env): Promise<SupaUser[]> {
  const conn = env.databaseUrl!;
  const local = conn.includes("localhost") || conn.includes("127.0.0.1");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: conn, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await client.query(
      "SELECT id::text AS id, email, created_at FROM auth.users WHERE email LIKE $1",
      [`%@${env.testEmailDomain}`],
    );
    return r.rows.map((row: { id: string; email: string | null; created_at: Date | string | null }) => ({
      id: row.id,
      email: row.email ?? undefined,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at ?? undefined),
    }));
  } finally {
    await client.end();
  }
}

async function listTestUsers(env: Env): Promise<SupaUser[]> {
  let users: SupaUser[];
  try {
    users = await listTestUsersViaApi(env);
  } catch (err) {
    if (!env.databaseUrl) throw err;
    log.warn(`admin list failed (${String((err as Error).message).slice(0, 90)}) — falling back to read-only DB query`);
    users = await listTestUsersViaDb(env);
  }
  return users.filter((u) => (u.email ?? "").endsWith(`@${env.testEmailDomain}`));
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
  let failed = 0;
  for (const u of stale) {
    if (opts.dryRun) {
      log.info(`  would delete ${u.email} (${u.id})`);
      continue;
    }
    try {
      await reclaimUser(env, u);
      removed++;
    } catch (err) {
      failed++;
      log.warn(`  could not reclaim ${u.email}: ${String((err as Error).message).slice(0, 120)}`);
    }
  }
  if (!opts.dryRun) {
    log.pass(`gc: reclaimed ${removed} stale test user(s)`);
    if (failed) log.fail(`gc: ${failed} could not be reclaimed (see warnings)`);
  }
}

async function reclaimUser(env: Env, u: SupaUser): Promise<void> {
  if (u.email) {
    const jwt = await passwordGrant(env, u.email, SYNTH_PASSWORD);
    const client = new Client(env.apiUrl).as({ label: "gc", auth: { mode: "bearer", token: jwt } });
    for (const accountId of await ownedAccountIds(client, u.id)) {
      await client.del("/v1/account/delete-immediately", { body: { account_id: accountId } });
    }
  }
  await adminDeleteUser(env, u.id);
}

async function ownedAccountIds(client: Client, userId: string): Promise<string[]> {
  const ids = new Set<string>([userId]);
  try {
    const res = await client.get("/v1/accounts");
    const body = res.json<{ accounts?: any[] } | any[]>();
    const list = Array.isArray(body) ? body : (body?.accounts ?? []);
    for (const a of list) {
      const id = a?.account_id ?? a?.id;
      if (id) ids.add(String(id));
    }
  } catch {
    // fall back to the personal account only
  }
  return [...ids];
}

/**
 * GC sweep. Every principal is a synthesized Supabase user under the test email
 * domain, so reclaiming those users (+ their cascade) is the primary leak guard.
 * Runs by email-domain prefix + age so it never touches an in-flight run.
 *
 * Uses the direct database when available so cleanup selects only test users.
 * Falls back to the paginated Supabase admin API when direct access is absent.
 */
import { Client } from "../core/client";
import { mapWithConcurrency } from "../core/concurrency";
import { loadEnv, type Env } from "../core/env";
import { log } from "../core/log";
import { adminDeleteUser, passwordGrant } from "./supabase";

const SYNTH_PASSWORD = "Ke2e-passw0rd-Aa1!";

/**
 * Email domains a test account can live under.
 *
 * `env.testEmailDomain` (default `ke2e.kortix.test`) covers every ke2e
 * principal minted by `principals.ts`. The Playwright suite mints its OWN users
 * directly against Supabase under `@example.test` and `@kortix.test`, which the
 * ke2e-only filter never saw — so before this list the sweep reclaimed exactly
 * zero browser-lane accounts. Override with `KE2E_GC_EMAIL_DOMAINS` (comma
 * separated). Every entry must be under a reserved TLD so no real user can be
 * matched.
 */
export const BROWSER_TEST_EMAIL_DOMAINS = ["example.test", "kortix.test"] as const;

export function resolveGcEmailDomains(env: Env): string[] {
  const configured = (process.env.KE2E_GC_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
  const domains = configured.length > 0
    ? configured
    : [env.testEmailDomain, ...BROWSER_TEST_EMAIL_DOMAINS];
  for (const domain of domains) {
    if (!/\.(test|invalid|localhost|example)$/.test(domain)) {
      throw new Error(
        `gc refuses email domain "${domain}": only reserved TLDs (.test/.invalid/.localhost/.example) are sweepable`,
      );
    }
  }
  return [...new Set(domains)];
}

export interface GcOptions {
  /** Reclaim accounts created before now minus this duration, e.g. "2h". */
  olderThan?: string;
  /**
   * Reclaim this run's own accounts at any age. `principals.ts:36` names every
   * principal `e2e-<runId>-<label>-…`, so the prefix targets exactly one run and
   * never touches a concurrent one. Unioned with `olderThan` when both are set.
   */
  runId?: string;
  dryRun: boolean;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)\s*([smhd])$/);
  if (!m) throw new Error(`bad --older-than "${s}" (use e.g. 30m, 2h, 1d)`);
  const n = Number(m[1]);
  return n * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as "s" | "m" | "h" | "d"];
}

/** Local-part prefix `principals.ts` gives every principal of one run. */
export function runIdEmailPrefix(runId: string): string {
  return `e2e-${runId}-`;
}

/** Which users this sweep reclaims. Exported so the unit tests can pin it. */
export function selectReclaimable(
  users: SupaUser[],
  opts: { cutoff?: number; runId?: string },
): SupaUser[] {
  const prefix = opts.runId ? runIdEmailPrefix(opts.runId) : null;
  return users.filter((u) => {
    if (prefix && (u.email ?? "").toLowerCase().startsWith(prefix.toLowerCase())) return true;
    if (opts.cutoff === undefined) return false;
    const created = u.created_at ? Date.parse(u.created_at) : 0;
    return created > 0 && created < opts.cutoff;
  });
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

async function listTestUsersViaDb(env: Env, domains: string[]): Promise<SupaUser[]> {
  const conn = env.databaseUrl!;
  const local = conn.includes("localhost") || conn.includes("127.0.0.1");
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: conn,
    // Same policy as database-project.ts / platform-admin.ts: Supabase's direct
    // Postgres endpoint presents a chain Node's default trust store rejects
    // ("self signed certificate in certificate chain"), which is what killed
    // both gc sweeps on the first sharded release-gate run (32222342409).
    ssl: local ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const r = await client.query(
      "SELECT id::text AS id, email, created_at FROM auth.users WHERE email LIKE ANY($1::text[])",
      [domains.map((domain) => `%@${domain}`)],
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

async function listTestUsers(env: Env, domains: string[]): Promise<SupaUser[]> {
  if (env.databaseUrl) return listTestUsersViaDb(env, domains);
  const users = await listTestUsersViaApi(env);
  return users.filter((u) =>
    domains.some((domain) => (u.email ?? "").endsWith(`@${domain}`)),
  );
}

export async function runGc(opts: GcOptions): Promise<void> {
  const env = loadEnv();
  if (!env.capabilities.supabaseAdmin || !env.supabaseAnonKey) {
    throw new Error("gc requires KE2E_SUPABASE_SERVICE_ROLE_KEY + KE2E_SUPABASE_ANON_KEY");
  }
  if (!opts.olderThan && !opts.runId) {
    throw new Error("gc requires --older-than and/or --run-id");
  }
  const domains = resolveGcEmailDomains(env);
  const cutoff = opts.olderThan ? Date.now() - parseDuration(opts.olderThan) : undefined;
  log.info(
    `gc: target=${env.target} domains=${domains.map((d) => `@${d}`).join(",")} ` +
      `olderThan=${opts.olderThan ?? "-"} runId=${opts.runId ?? "-"} dryRun=${opts.dryRun}`,
  );

  const users = await listTestUsers(env, domains);
  const stale = selectReclaimable(users, { cutoff, runId: opts.runId });

  log.info(`gc: ${users.length} test user(s) found, ${stale.length} selected for reclaim`);
  let removed = 0;
  let failed = 0;
  const configuredWorkers = Number(process.env.KE2E_GC_WORKERS ?? 8);
  const workers =
    Number.isFinite(configuredWorkers) && configuredWorkers > 0
      ? Math.min(32, Math.trunc(configuredWorkers))
      : 8;
  log.info(`gc: reclaiming with ${workers} workers`);
  await mapWithConcurrency(stale, workers, async (u) => {
    if (opts.dryRun) {
      log.info(`  would delete ${u.email} (${u.id})`);
      return;
    }
    try {
      await reclaimUser(env, u);
      removed++;
    } catch (err) {
      failed++;
      log.warn(`  could not reclaim ${u.email}: ${String((err as Error).message).slice(0, 120)}`);
    }
  });
  if (!opts.dryRun) {
    log.pass(`gc: reclaimed ${removed} stale test user(s)`);
    if (failed) log.fail(`gc: ${failed} could not be reclaimed (see warnings)`);
  }
}

async function reclaimUser(env: Env, u: SupaUser): Promise<void> {
  if (u.email) {
    // Best effort. Only ke2e principals share SYNTH_PASSWORD; the Playwright
    // suite mints its users with per-spec passwords, so the grant legitimately
    // fails for them. Deleting the Supabase user is the reclaim that must
    // always happen, so a failed grant must never abort it.
    try {
      const jwt = await passwordGrant(env, u.email, SYNTH_PASSWORD);
      const client = new Client(env.apiUrl).as({
        label: "gc",
        auth: { mode: "bearer", token: jwt },
      });
      for (const accountId of await ownedAccountIds(client, u.id)) {
        // The route is mounted under /v1/billing (billing/routes/account-deletion.ts:92)
        // — the same path world.ts teardown uses. The old un-prefixed path 404'd,
        // so no GC sweep ever reached stopAccountSandboxes().
        await client.del("/v1/billing/account/delete-immediately", {
          body: { account_id: accountId },
        });
      }
    } catch (err) {
      log.warn(
        `  account delete skipped for ${u.email}: ${String((err as Error).message).slice(0, 120)}`,
      );
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

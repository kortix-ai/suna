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

/**
 * SSL policy for a direct Postgres connection.
 *
 * Same policy as database-project.ts / platform-admin.ts: Supabase's direct
 * Postgres endpoint presents a chain Node's default trust store rejects
 * ("self signed certificate in certificate chain"), which is what killed both
 * gc sweeps on the first sharded release-gate run (32222342409). A local
 * connection uses no TLS at all.
 */
export function gcDbSsl(conn: string): false | { rejectUnauthorized: false } {
  const local = conn.includes("localhost") || conn.includes("127.0.0.1");
  return local ? false : { rejectUnauthorized: false };
}

/** Minimal shape of the `pg` pool this module uses, so tests can fake it. */
export interface GcDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

async function openGcDb(conn: string): Promise<GcDb> {
  const { Pool } = await import("pg");
  // A pool, not a single Client: `reclaimUser` runs under `mapWithConcurrency`,
  // so several workers query at once. One Client would serialise all of them.
  return new Pool({ connectionString: conn, ssl: gcDbSsl(conn), max: 8 }) as unknown as GcDb;
}

async function listTestUsersViaDb(env: Env, domains: string[]): Promise<SupaUser[]> {
  const db = await openGcDb(env.databaseUrl!);
  try {
    const r = await db.query(
      "SELECT id::text AS id, email, created_at FROM auth.users WHERE email LIKE ANY($1::text[])",
      [domains.map((domain) => `%@${domain}`)],
    );
    return r.rows.map((row: { id: string; email: string | null; created_at: Date | string | null }) => ({
      id: row.id,
      email: row.email ?? undefined,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at ?? undefined),
    }));
  } finally {
    await db.end();
  }
}

/**
 * Every account this user OWNS, straight from the database.
 *
 * The API-driven `ownedAccountIds` below needs a working password grant, which
 * the Playwright lane's users legitimately do not have. This one always works
 * wherever `KE2E_DATABASE_URL` is set, which is the release gate.
 */
export async function ownedAccountIdsViaDb(db: GcDb, userId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT account_id::text AS account_id
       FROM kortix.account_members
      WHERE user_id = $1::uuid AND account_role = 'owner'`,
    [userId],
  );
  return r.rows.map((row: { account_id: string }) => row.account_id);
}

/**
 * Revoke EVERY token in these accounts, setting both columns.
 *
 * Both columns, because they are two halves of one invariant and nothing in the
 * database ties them together — no CHECK, no trigger, no partial index. The
 * sweep used to stamp `revoked_at` alone, and `validateAccountToken` gated on
 * `status` alone, so 186 "Connector Session" tokens kept authenticating after a
 * "successful" revoke and their agents kept hitting the staging gateway until it
 * reported `degraded`. The API side is fixed
 * (apps/api/src/repositories/account-tokens.ts), and this write no longer
 * depends on that fix being present.
 *
 * The `OR status = 'active'` arm also heals any row already left in the
 * inconsistent state by an earlier sweep.
 */
export async function revokeAccountTokens(db: GcDb, accountIds: string[]): Promise<number> {
  if (accountIds.length === 0) return 0;
  const r = await db.query(
    `UPDATE kortix.account_tokens
        SET status = 'revoked', revoked_at = now()
      WHERE account_id = ANY($1::uuid[])
        AND (revoked_at IS NULL OR status = 'active')
      RETURNING token_id`,
    [accountIds],
  );
  return r.rows.length;
}

/**
 * Sessions in these accounts that still claim to be alive, or whose sandbox row
 * still points at a box the provider has not been told to release.
 *
 * The sandbox arm matters as much as the session arm: run 32231251280 left 47
 * sessions whose `project_sessions.status` was already settled but whose
 * `session_sandboxes` row still carried a live `external_id`.
 */
export async function listLiveSessions(
  db: GcDb,
  accountIds: string[],
): Promise<Array<{ sessionId: string; projectId: string }>> {
  if (accountIds.length === 0) return [];
  const r = await db.query(
    `SELECT DISTINCT s.session_id, s.project_id::text AS project_id
       FROM kortix.project_sessions s
       LEFT JOIN kortix.session_sandboxes sb ON sb.session_id = s.session_id
      WHERE s.account_id = ANY($1::uuid[])
        AND (
          s.status IN ('queued', 'branching', 'provisioning', 'running')
          OR (sb.external_id IS NOT NULL AND sb.status IN ('provisioning', 'active', 'error'))
        )`,
    [accountIds],
  );
  return r.rows.map((row: { session_id: string; project_id: string }) => ({
    sessionId: row.session_id,
    projectId: row.project_id,
  }));
}

/**
 * Which stop responses mean "this box is no longer our problem".
 *
 * 409 is "not running" and 404 is "already gone" — both are the desired end
 * state, so counting them as failures would make a clean sweep look broken.
 */
export function isSessionReclaimed(statusCode: number): boolean {
  return statusCode < 300 || statusCode === 404 || statusCode === 409;
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
  const summary: GcSummary = { sessionsStopped: 0, tokensRevoked: 0, errors: 0 };
  const configuredWorkers = Number(process.env.KE2E_GC_WORKERS ?? 8);
  const workers =
    Number.isFinite(configuredWorkers) && configuredWorkers > 0
      ? Math.min(32, Math.trunc(configuredWorkers))
      : 8;
  log.info(`gc: reclaiming with ${workers} workers`);

  // One pool for the whole sweep. Without a database URL the sweep still runs,
  // just without the belt-and-braces session/token reclaim.
  const db = !opts.dryRun && env.databaseUrl ? await openGcDb(env.databaseUrl) : null;
  if (!db && !opts.dryRun) {
    log.warn("gc: no KE2E_DATABASE_URL — session + token reclaim is disabled for this sweep");
  }

  try {
    await mapWithConcurrency(stale, workers, async (u) => {
      if (opts.dryRun) {
        log.info(`  would delete ${u.email} (${u.id})`);
        return;
      }
      try {
        await reclaimUser(env, u, db, summary);
        removed++;
      } catch (err) {
        failed++;
        log.warn(`  could not reclaim ${u.email}: ${String((err as Error).message).slice(0, 120)}`);
      }
    });
  } finally {
    await db?.end().catch(() => {});
  }

  if (!opts.dryRun) {
    log.pass(
      `gc: reclaimed ${removed} stale test user(s); ` +
        `sessions stopped=${summary.sessionsStopped} tokens revoked=${summary.tokensRevoked} ` +
        `reclaim errors=${summary.errors}`,
    );
    if (failed) log.fail(`gc: ${failed} could not be reclaimed (see warnings)`);
  }
}

export interface GcSummary {
  sessionsStopped: number;
  tokensRevoked: number;
  errors: number;
}

/**
 * Reclaim one test user.
 *
 * Order is deliberate and is the whole point of this function:
 *
 *   1. Revoke every token in every account the user owns. This is FIRST because
 *      it is the only step that needs neither a password grant nor a healthy
 *      API, and it is what actually stops a surviving sandbox agent from
 *      authenticating. When the API shards were killed at their 40-minute cap,
 *      the agents that kept the staging gateway `degraded` were all running on
 *      credentials a "successful" sweep had left live.
 *   2. Stop each still-live session through the API, so the provider is told to
 *      release the box rather than waiting for account deletion to get there.
 *   3. Delete the account, which stops AND removes anything step 2 missed.
 *   4. Delete the Supabase user — the reclaim that must always happen.
 *
 * Every step is best-effort and independent: a failure in one must never skip
 * the rest, because each one alone still shrinks the leak.
 */
async function reclaimUser(
  env: Env,
  u: SupaUser,
  db: GcDb | null,
  summary: GcSummary,
): Promise<void> {
  const accountIds = new Set<string>([u.id]);

  if (db) {
    try {
      for (const id of await ownedAccountIdsViaDb(db, u.id)) accountIds.add(id);
    } catch (err) {
      summary.errors++;
      log.warn(`  owned-account lookup failed for ${u.email}: ${errText(err)}`);
    }
    try {
      summary.tokensRevoked += await revokeAccountTokens(db, [...accountIds]);
    } catch (err) {
      summary.errors++;
      log.warn(`  token revoke failed for ${u.email}: ${errText(err)}`);
    }
  }

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
      for (const id of await ownedAccountIds(client, u.id)) accountIds.add(id);

      if (db) {
        summary.sessionsStopped += await stopLiveSessions(client, db, [...accountIds], summary);
      }

      // ONE call. The route resolves the caller's earliest-joined account
      // (shared/resolve-account.ts) and ignores a body `account_id`, but
      // `deleteAccountImmediately` now sweeps the sandboxes of EVERY account
      // the caller owns, so a per-account loop would just repeat the same work.
      await client.del("/v1/billing/account/delete-immediately");
    } catch (err) {
      summary.errors++;
      log.warn(`  account delete skipped for ${u.email}: ${errText(err)}`);
    }
  }

  await adminDeleteUser(env, u.id);
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 120);
}

/** Stop every live session in these accounts through the real stop route. */
async function stopLiveSessions(
  client: Client,
  db: GcDb,
  accountIds: string[],
  summary: GcSummary,
): Promise<number> {
  let stopped = 0;
  let sessions: Array<{ sessionId: string; projectId: string }>;
  try {
    sessions = await listLiveSessions(db, accountIds);
  } catch (err) {
    summary.errors++;
    log.warn(`  live-session lookup failed: ${errText(err)}`);
    return 0;
  }

  await mapWithConcurrency(sessions, 4, async (s) => {
    try {
      const res = await client.post(
        "/v1/projects/:projectId/sessions/:sessionId/stop",
        {},
        { params: { projectId: s.projectId, sessionId: s.sessionId } },
      );
      if (isSessionReclaimed(res.statusCode)) {
        stopped++;
      } else {
        summary.errors++;
        log.warn(`  stop ${s.sessionId} returned ${res.statusCode}`);
      }
    } catch (err) {
      summary.errors++;
      log.warn(`  stop ${s.sessionId} failed: ${errText(err)}`);
    }
  });

  return stopped;
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

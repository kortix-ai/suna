/**
 * The workspace invariants (design.md §7 "Verification"), read-only. Each
 * check returns how many rows break it and up to 10 internal ids as a sample.
 * Run after every split batch: `apps/api/scripts/workspace-invariants.ts`.
 *
 *   I1  no account holds 2+ active projects that are not split-pending, and
 *       no account holds exactly 1 active project that is still split-pending
 *   I2  on every moved table, a split project's rows carry its account; the
 *       project default model (keyed by scope_key) too
 *   I3  every secret of a split-off account decrypts with that account's key
 *   I4  every user holding a grant is a member of the grant's account
 *   I5  money stayed: each split-off account had no billing of its own at
 *       the move, the source kept its Stripe customers, the split-off holds
 *       one wallet with at most one split-off grant (C6), its billing applied
 *       within 10 minutes of the move (plan.billing), and no open compute row
 *       of the moved boxes still bills the source
 *   I6  a 1:1 workspace's account name equals its project name
 *   I7  each principal reaches the moved workspace through as many grants as
 *       before the move
 *   I8  every member the split added to a split-off account reaches the
 *       moved workspace by the split's own rule (reachingUsersSql: a grant on
 *       it, an owner/admin or custom account role, a reaching group, a
 *       project secret grant, super admin); an account member grant alone
 *       does not count (design.md §3.1 row 6)
 *   I9  the kortix.workspaces table equals kortix.workspaces_expected for every
 *       account (the reconcile triggers missed no write)
 *   I10 every expand-table row carries workspace_id = the account's live id,
 *       except the rows of a split_pending account (NULL until the split
 *       fills them)
 *   I11 no two credit_accounts rows share a stripe_subscription_id
 *   I12 every account has exactly one live row, or one per active project
 *       while split_pending
 *
 * I2, I3, I5, I7 and I8 read only the `done` split runs (scoped by `runIds` when
 * given); I1, I4, I6 and I9–I12 read the whole database, or only `accountIds`
 * when given (I9, I10, I12).
 */
import { sql } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import { db } from '../../shared/db';
import { probeAccountSecret } from '../../secrets/account-resource';
import { PROJECT_TRANSFER_TABLES, projectGrantCounts, reachingUsersSql, type SplitCopiedIds } from '../../projects/surface';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8' | 'I9' | 'I10' | 'I11' | 'I12';

export interface InvariantResult {
  ok: boolean;
  violations: number;
  sample: string[];
}

export type WorkspaceInvariantReport = Record<InvariantId, InvariantResult>;

const SAMPLE = 10;
const result = (violations: string[]): InvariantResult => ({ ok: violations.length === 0, violations: violations.length, sample: violations.slice(0, SAMPLE) });

interface DoneRun extends Record<string, unknown> {
  run_id: string;
  project_id: string;
  from_account_id: string;
  to_account_id: string;
  completed_at: string;
  plan: Record<string, unknown>;
  copied_ids: SplitCopiedIds;
}

async function doneRuns(runIds?: string[]): Promise<DoneRun[]> {
  const filter = runIds ? sql`AND run_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(runIds)}::jsonb))` : sql``;
  return db.execute<DoneRun>(sql`
    SELECT run_id::text, project_id::text, from_account_id::text, to_account_id::text, completed_at::text, plan, copied_ids
      FROM kortix.workspace_split_runs WHERE phase = 'done' ${filter} ORDER BY completed_at`);
}

async function i1(): Promise<InvariantResult> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT account_id::text AS id FROM kortix.projects WHERE status = 'active' AND NOT split_pending
     GROUP BY account_id HAVING count(*) > 1
    UNION ALL
    -- The reverse: a flag left on an account's only active project (finding 27).
    SELECT 'stale_flag:' || account_id::text FROM kortix.projects WHERE status = 'active'
     GROUP BY account_id HAVING count(*) = 1 AND bool_or(split_pending)`);
  return result(rows.map((row) => row.id));
}

async function i2(runs: DoneRun[]): Promise<InvariantResult> {
  const projectIds = runs.map((run) => run.project_id);
  if (!projectIds.length) return result([]);
  const violations: string[] = [];
  for (const table of PROJECT_TRANSFER_TABLES) {
    const name = getTableName(table);
    const [row] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ${table} t JOIN kortix.projects p ON p.project_id = t.project_id
       WHERE t.project_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND t.account_id <> p.account_id`);
    if (row && row.n > 0) violations.push(`${name}:${row.n}`);
  }
  for (const [name, query] of [
    ['app_site_files', sql`SELECT count(*)::int AS n FROM kortix.app_site_files f JOIN kortix.app_deployments d USING (deployment_id) JOIN kortix.apps a USING (app_id)
       WHERE a.project_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND f.account_id <> a.account_id`],
    ['app_runtimes', sql`SELECT count(*)::int AS n FROM kortix.app_runtimes r JOIN kortix.app_deployments d USING (deployment_id) JOIN kortix.apps a USING (app_id)
       WHERE a.project_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND r.account_id <> a.account_id`],
    ['app_volumes', sql`SELECT count(*)::int AS n FROM kortix.app_volumes v JOIN kortix.apps a USING (app_id)
       WHERE a.project_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND v.account_id <> a.account_id`],
    ['oauth_clients.app_id', sql`SELECT count(*)::int AS n FROM kortix.oauth_clients oc JOIN kortix.apps a USING (app_id)
       WHERE a.project_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND oc.account_id <> a.account_id`],
    ['oauth_access_tokens.app_client', sql`SELECT count(*)::int AS n FROM kortix.oauth_access_tokens t JOIN kortix.oauth_clients oc USING (client_id)
       JOIN kortix.apps a USING (app_id)
       WHERE a.project_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND t.account_id <> a.account_id`],
    ['role_assignments', sql`SELECT count(*)::int AS n FROM kortix.role_assignments ra JOIN kortix.projects p ON p.project_id = ra.scope_id
       WHERE ra.scope_type = 'project' AND ra.scope_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND ra.account_id <> p.account_id`],
    // The project default model is keyed by scope_key (its project_id is NULL).
    ['account_model_preferences.scope_key', sql`SELECT count(*)::int AS n FROM kortix.account_model_preferences mp
       JOIN kortix.projects p ON p.project_id::text = mp.scope_key
       WHERE mp.scope = 'project' AND mp.project_id IS NULL
         AND mp.scope_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND mp.account_id <> p.account_id`],
  ] as const) {
    const [row] = await db.execute<{ n: number }>(query);
    if (row && row.n > 0) violations.push(`${name}:${row.n}`);
  }
  return result(violations);
}

async function i3(runs: DoneRun[]): Promise<InvariantResult> {
  const accounts = [...new Set(runs.map((run) => run.to_account_id))];
  if (!accounts.length) return result([]);
  const rows = await db.execute<{ kind: string; id: string; account_id: string; value_enc: string }>(sql`
    SELECT 'secret' AS kind, secret_id::text AS id, account_id::text, value_enc FROM kortix.account_secret_resources
     WHERE account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(accounts)}::jsonb))
    UNION ALL SELECT 'github_user_token', token_row_id::text, account_id::text, value_enc FROM kortix.account_github_user_tokens
     WHERE account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(accounts)}::jsonb))
    UNION ALL SELECT 'claude_login', user_id::text, account_id::text, value_enc FROM kortix.claude_subscription_logins
     WHERE account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(accounts)}::jsonb))`);
  // A secret the source could not decrypt either was left behind (account-wide)
  // or moved unchanged and marked for a reconnect (project-scoped); the run
  // lists both in copied_ids.undecryptableSecrets.
  const known = new Set(runs.flatMap((run) => run.copied_ids.undecryptableSecrets ?? []));
  return result(
    rows
      .filter((row) => !(row.kind === 'secret' && known.has(row.id)))
      .filter((row) => probeAccountSecret(row.account_id, row.value_enc) !== 'ok')
      .map((row) => `${row.kind}:${row.id}`),
  );
}

async function i4(): Promise<InvariantResult> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT ra.account_id::text || ':' || ra.principal_id::text AS id FROM kortix.role_assignments ra
     WHERE ra.principal_type = 'user' AND (ra.expires_at IS NULL OR ra.expires_at > now())
       AND NOT EXISTS (SELECT 1 FROM kortix.account_memberships m WHERE m.account_id = ra.account_id AND m.user_id = ra.principal_id)
     ORDER BY 1`);
  return result(rows.map((row) => row.id));
}

/** How long a done run may wait for its billing (applySplitOffBilling after commit, retried by the tick). */
const BILLING_GRACE = '10 minutes';

async function i5(runs: DoneRun[]): Promise<InvariantResult> {
  const violations: string[] = [];
  for (const run of runs) {
    const [money] = await db.execute<{ target_billing: number; source_customers: number; target_wallet: number; split_grants: number; billing_late: boolean; source_open_compute: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM kortix.billing_customers WHERE account_id = ${run.to_account_id})
        + (SELECT count(*)::int FROM kortix.credit_purchases WHERE account_id = ${run.to_account_id} AND created_at <= ${run.completed_at}::timestamptz)
        + (SELECT count(*)::int FROM kortix.enterprise_contracts WHERE account_id = ${run.to_account_id} AND created_at <= ${run.completed_at}::timestamptz) AS target_billing,
        (SELECT count(*)::int FROM kortix.billing_customers WHERE account_id = ${run.from_account_id}) AS source_customers,
        (SELECT count(*)::int FROM kortix.credit_accounts WHERE account_id = ${run.to_account_id}) AS target_wallet,
        (SELECT count(*)::int FROM kortix.credit_ledger WHERE account_id = ${run.to_account_id} AND stripe_event_id LIKE 'split\_off\_%') AS split_grants,
        (NOT (${JSON.stringify(run.plan)}::jsonb ? 'billing') AND ${run.completed_at}::timestamptz < now() - ${BILLING_GRACE}::interval) AS billing_late,
        (SELECT count(*)::int FROM kortix.sandbox_compute_sessions c
          WHERE c.ended_at IS NULL AND c.account_id = ${run.from_account_id} AND c.sandbox_id IN (
            SELECT sandbox_id FROM kortix.session_sandboxes WHERE project_id = ${run.project_id} AND sandbox_id IS NOT NULL
            UNION SELECT r.runtime_id FROM kortix.app_runtimes r
              JOIN kortix.app_deployments d ON d.deployment_id = r.deployment_id
              JOIN kortix.apps a ON a.app_id = d.app_id WHERE a.project_id = ${run.project_id}
            UNION SELECT box_id FROM kortix.project_monitor_boxes WHERE project_id = ${run.project_id})) AS source_open_compute`);
    const planned = Number((run.plan.account as Record<string, unknown> | undefined)?.billing_customers ?? 0);
    if (!money) continue;
    if (money.target_billing > 0) violations.push(`target_billing:${run.run_id}`);
    if (money.source_customers < planned) violations.push(`source_lost_customer:${run.run_id}`);
    if (money.target_wallet !== 1) violations.push(`target_wallet:${run.run_id}`);
    // One split-off grant per move (C6: split_off_grant / split_off_comp, keyed by run).
    if (money.split_grants > 1) violations.push(`split_grants:${run.run_id}`);
    // ... and at least one when the billing granted credits: a replayed key
    // reports the grant without a row on this account.
    const granted = Number((run.plan.billing as Record<string, unknown> | undefined)?.grantedCredits ?? 0);
    if (granted > 0 && money.split_grants < 1) violations.push(`split_grant_missing:${run.run_id}`);
    if (money.billing_late) violations.push(`billing_pending:${run.run_id}`);
    // The moved boxes' running meters bill the workspace that holds them now.
    if (money.source_open_compute > 0) violations.push(`source_open_compute:${run.run_id}`);
  }
  return result(violations);
}

async function i6(): Promise<InvariantResult> {
  const rows = await db.execute<{ account_id: string }>(sql`
    SELECT a.account_id::text FROM kortix.accounts a
      JOIN kortix.projects p ON p.account_id = a.account_id AND p.status = 'active' AND NOT p.split_pending
     WHERE a.name IS DISTINCT FROM p.name
       AND (SELECT count(*) FROM kortix.projects q WHERE q.account_id = a.account_id AND q.status = 'active') = 1
     ORDER BY 1`);
  return result(rows.map((row) => row.account_id));
}

async function i7(runs: DoneRun[]): Promise<InvariantResult> {
  const violations: string[] = [];
  for (const run of runs) {
    const before = (run.plan.grants_before ?? {}) as Record<string, number>;
    const back = Object.fromEntries(Object.entries(run.copied_ids.groups ?? {}).map(([source, copy]) => [copy, source]));
    const after = await db.transaction((tx) => projectGrantCounts(tx, run.to_account_id, run.project_id, back));
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if ((before[key] ?? 0) !== (after[key] ?? 0)) violations.push(`${run.run_id}:${key}`);
    }
  }
  return result(violations);
}

async function i8(runs: DoneRun[]): Promise<InvariantResult> {
  const violations: string[] = [];
  for (const run of runs) {
    const added = JSON.stringify(run.copied_ids.memberships ?? []);
    // Only while the project still lives in its split-off account.
    const rows = await db.execute<{ user_id: string }>(sql`
      SELECT m.user_id::text FROM kortix.account_memberships m
       WHERE m.account_id = ${run.to_account_id}
         AND m.user_id::text IN (SELECT jsonb_array_elements_text(${added}::jsonb))
         AND EXISTS (SELECT 1 FROM kortix.projects p WHERE p.project_id = ${run.project_id} AND p.account_id = ${run.to_account_id})
         AND m.user_id NOT IN (${reachingUsersSql(run.to_account_id, run.project_id)})
       ORDER BY 1`);
    violations.push(...rows.map((row) => `${run.to_account_id}:${row.user_id}`));
  }
  return result(violations);
}

/** The accounts an identity invariant reads: `accountIds`, or every account. */
const accountSet = (accountIds?: string[]) =>
  accountIds
    ? sql`SELECT jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb)::uuid AS id`
    : sql`SELECT account_id AS id FROM kortix.accounts`;

async function i9(accountIds?: string[]): Promise<InvariantResult> {
  const rows = await db.execute<{ account_id: string }>(sql`
    SELECT a.id::text AS account_id FROM (${accountSet(accountIds)}) a
     WHERE EXISTS (
       (SELECT to_jsonb(e) - 'synced_at' FROM kortix.workspaces_expected(a.id) e
        EXCEPT SELECT to_jsonb(w) - 'synced_at' FROM kortix.workspaces w
                WHERE w.legacy_account_id = a.id OR w.former_account_id = a.id)
       UNION ALL
       (SELECT to_jsonb(w) - 'synced_at' FROM kortix.workspaces w
         WHERE w.legacy_account_id = a.id OR w.former_account_id = a.id
        EXCEPT SELECT to_jsonb(e) - 'synced_at' FROM kortix.workspaces_expected(a.id) e))
     ORDER BY 1`);
  return result(rows.map((row) => row.account_id));
}

async function i10(accountIds?: string[]): Promise<InvariantResult> {
  const tables = await db.execute<{ name: string }>(sql`
    SELECT t.name FROM unnest(kortix.workspace_expand_tables()) AS t(name)
     WHERE EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = to_regclass('kortix.' || quote_ident(t.name))
                      AND a.attname = 'workspace_id' AND NOT a.attisdropped)
     ORDER BY 1`);
  const filter = accountIds
    ? sql`AND t.account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb))`
    : sql``;
  const violations: string[] = [];
  for (const { name } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
    const [row] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ${sql.raw(`kortix.${name}`)} t
        LEFT JOIN kortix.workspaces w
          ON w.legacy_account_id = t.account_id AND w.lifecycle <> 'tombstone' AND NOT w.split_pending
       WHERE t.account_id IS NOT NULL ${filter}
         AND NOT EXISTS (SELECT 1 FROM kortix.projects p
                          WHERE p.account_id = t.account_id AND p.status = 'active' AND p.split_pending)
         AND t.workspace_id IS DISTINCT FROM w.workspace_id`);
    if (row && row.n > 0) violations.push(`${name}:${row.n}`);
  }
  return result(violations);
}

async function i11(): Promise<InvariantResult> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT stripe_subscription_id AS id FROM kortix.credit_accounts
     WHERE stripe_subscription_id IS NOT NULL
     GROUP BY stripe_subscription_id HAVING count(*) > 1
     ORDER BY 1`);
  return result(rows.map((row) => row.id));
}

async function i12(accountIds?: string[]): Promise<InvariantResult> {
  const rows = await db.execute<{ account_id: string }>(sql`
    SELECT a.id::text AS account_id FROM (${accountSet(accountIds)}) a
     WHERE EXISTS (SELECT 1 FROM kortix.accounts x WHERE x.account_id = a.id)
       AND (SELECT count(*) FROM kortix.workspaces w WHERE w.legacy_account_id = a.id AND w.lifecycle <> 'tombstone')
           <> greatest(1, (SELECT count(*) FROM kortix.projects p
                            WHERE p.account_id = a.id AND p.status = 'active' AND p.split_pending))
     ORDER BY 1`);
  return result(rows.map((row) => row.account_id));
}

/** I2 alone for the given done runs: the split runner's repair pass checks its run with it. */
export async function checkSplitRunsMoved(runIds: string[]): Promise<InvariantResult> {
  return i2(await doneRuns(runIds));
}

/** Every invariant, read-only. `runIds` narrows I2, I3, I5, I7 and I8; `accountIds` narrows I9, I10 and I12. */
export async function checkWorkspaceInvariants(
  options: { runIds?: string[]; accountIds?: string[] } = {},
): Promise<WorkspaceInvariantReport> {
  const runs = await doneRuns(options.runIds);
  return {
    I1: await i1(),
    I2: await i2(runs),
    I3: await i3(runs),
    I4: await i4(),
    I5: await i5(runs),
    I6: await i6(),
    I7: await i7(runs),
    I8: await i8(runs),
    I9: await i9(options.accountIds),
    I10: await i10(options.accountIds),
    I11: await i11(),
    I12: await i12(options.accountIds),
  };
}

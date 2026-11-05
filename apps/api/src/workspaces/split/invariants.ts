/**
 * The workspace invariants (design.md §7 "Verification"), read-only. Each
 * check returns how many rows break it and up to 10 internal ids as a sample.
 * Run after every split batch: `apps/api/scripts/workspace-invariants.ts`.
 *
 *   I1  no account holds 2+ active projects that are not split-pending
 *   I2  on every moved table, a split project's rows carry its account
 *   I3  every secret of a split-off account decrypts with that account's key
 *   I4  every user holding a grant is a member of the grant's account
 *   I5  money stayed: each split-off account had no billing at the move, and
 *       the source kept its Stripe customers
 *   I6  a 1:1 workspace's account name equals its project name
 *   I7  each principal reaches the moved workspace through as many grants as
 *       before the move
 *
 * I2, I3, I5 and I7 read only the `done` split runs (scoped by `runIds` when
 * given); I1, I4 and I6 read the whole database.
 */
import { sql } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import { db } from '../../shared/db';
import { probeAccountSecret } from '../../secrets/account-resource';
import { PROJECT_TRANSFER_TABLES, projectGrantCounts, type SplitCopiedIds } from '../../projects/surface';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7';

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
  const rows = await db.execute<{ account_id: string }>(sql`
    SELECT account_id::text FROM kortix.projects WHERE status = 'active' AND NOT split_pending
     GROUP BY account_id HAVING count(*) > 1`);
  return result(rows.map((row) => row.account_id));
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
    ['role_assignments', sql`SELECT count(*)::int AS n FROM kortix.role_assignments ra JOIN kortix.projects p ON p.project_id = ra.scope_id
       WHERE ra.scope_type = 'project' AND ra.scope_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(projectIds)}::jsonb)) AND ra.account_id <> p.account_id`],
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
  // A secret the source could not decrypt either was left behind on purpose.
  return result(rows.filter((row) => probeAccountSecret(row.account_id, row.value_enc) !== 'ok').map((row) => `${row.kind}:${row.id}`));
}

async function i4(): Promise<InvariantResult> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT ra.account_id::text || ':' || ra.principal_id::text AS id FROM kortix.role_assignments ra
     WHERE ra.principal_type = 'user' AND (ra.expires_at IS NULL OR ra.expires_at > now())
       AND NOT EXISTS (SELECT 1 FROM kortix.account_memberships m WHERE m.account_id = ra.account_id AND m.user_id = ra.principal_id)
     ORDER BY 1`);
  return result(rows.map((row) => row.id));
}

async function i5(runs: DoneRun[]): Promise<InvariantResult> {
  const violations: string[] = [];
  for (const run of runs) {
    const [money] = await db.execute<{ target_billing: number; source_customers: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM kortix.billing_customers WHERE account_id = ${run.to_account_id})
        + (SELECT count(*)::int FROM kortix.credit_purchases WHERE account_id = ${run.to_account_id} AND created_at <= ${run.completed_at}::timestamptz)
        + (SELECT count(*)::int FROM kortix.enterprise_contracts WHERE account_id = ${run.to_account_id} AND created_at <= ${run.completed_at}::timestamptz) AS target_billing,
        (SELECT count(*)::int FROM kortix.billing_customers WHERE account_id = ${run.from_account_id}) AS source_customers`);
    const planned = Number((run.plan.account as Record<string, unknown> | undefined)?.billing_customers ?? 0);
    if (!money) continue;
    if (money.target_billing > 0) violations.push(`target_billing:${run.run_id}`);
    if (money.source_customers < planned) violations.push(`source_lost_customer:${run.run_id}`);
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

/** Every invariant, read-only. `runIds` narrows I2, I3, I5 and I7. */
export async function checkWorkspaceInvariants(options: { runIds?: string[] } = {}): Promise<WorkspaceInvariantReport> {
  const runs = await doneRuns(options.runIds);
  return {
    I1: await i1(),
    I2: await i2(runs),
    I3: await i3(runs),
    I4: await i4(),
    I5: await i5(runs),
    I6: await i6(),
    I7: await i7(runs),
  };
}

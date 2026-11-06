/**
 * The workspace split runner (Workspaces design.md §2 row "S"): every project
 * of a legacy multi-project account except the keeper becomes its own
 * workspace. The data movement is `splitProjectIntoNewAccount`
 * (projects/lib/workspace-split-copy.ts); this module owns the plan, the
 * ledger (`kortix.workspace_split_runs`), the lease and the mode.
 *
 * Ledger phases (one row per project to move):
 *
 *   planned         dry-run plan; apply may take it
 *   held            the account took money (a completed purchase, a Stripe
 *                   subscription, an enterprise contract): its owner chooses the
 *                   keeper first (`confirmWorkspaceSplitKeeper`)
 *   storage_copied  the project's static App blobs are copied to the target
 *                   prefix; the database move is next (a resume starts here)
 *   done            moved; `copied_ids` lists every copy, `to_account_id` the
 *                   new workspace's account
 *   failed          MAX_ATTEMPTS attempts failed; `error` says why
 *   skipped         no longer needed (the project left, became the keeper, or
 *                   the account holds one project)
 *   reversed        undone by `reverseWorkspaceSplitRun`; the project is not
 *                   planned again while this row exists
 *
 * Keeper: the most recently opened active project (then newest created). It
 * keeps the account, its credits, plan and Stripe customer. The keeper is
 * frozen once a move of the account started, or once an owner confirmed it.
 *
 * Lease: a claim sets `heartbeat_at` and increments `attempts`; a run whose
 * heartbeat is older than LEASE_MS is reclaimable (a crash mid-run). The move
 * itself is one transaction, so a crash inside it moves nothing.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { platformSettings, workspaceSplitRuns } from '@kortix/db';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import type { SiteStorage } from '../../apps/static-site';
import {
  copyProjectSiteBlobs,
  projectGrantCounts,
  ProjectSplitError,
  reverseProjectSplit,
  splitProjectIntoNewAccount,
  type SplitCopiedIds,
} from '../../projects/surface';

export type WorkspaceSplitMode = 'off' | 'dry_run' | 'apply';
export type WorkspaceSplitPhase = 'planned' | 'held' | 'storage_copied' | 'done' | 'failed' | 'skipped' | 'reversed';

export const WORKSPACE_SPLIT_SETTING_KEY = 'workspace_split';
export const WORKSPACE_SPLIT_LEASE_MS = 10 * 60_000;
export const WORKSPACE_SPLIT_MAX_ATTEMPTS = 5;

type RunRow = typeof workspaceSplitRuns.$inferSelect;

/** The mode: the `workspace_split` platform setting, else WORKSPACE_SPLIT_MODE. */
export async function workspaceSplitMode(): Promise<WorkspaceSplitMode> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings)
    .where(eq(platformSettings.key, WORKSPACE_SPLIT_SETTING_KEY));
  const mode = (row?.value as { mode?: unknown } | undefined)?.mode;
  return mode === 'off' || mode === 'dry_run' || mode === 'apply' ? mode : config.WORKSPACE_SPLIT_MODE;
}

type AccountProject = { project_id: string; last_opened_at: string | null; created_at: string };

async function keeperFor(accountId: string, projects: AccountProject[]): Promise<{ keeperId: string; confirmed: boolean; frozen: boolean }> {
  const active = new Set(projects.map((p) => p.project_id));
  const frozen = await db.execute<{ keeper: string; confirmed: boolean }>(sql`
    SELECT plan->>'keeper_project_id' AS keeper, COALESCE((plan->>'keeper_confirmed')::boolean, false) AS confirmed
      FROM kortix.workspace_split_runs
     WHERE from_account_id = ${accountId} AND phase <> 'reversed'
       AND (phase IN ('storage_copied', 'done') OR COALESCE((plan->>'keeper_confirmed')::boolean, false))
     ORDER BY COALESCE((plan->>'keeper_confirmed')::boolean, false) DESC, updated_at DESC`);
  const kept = frozen.find((row) => row.keeper && active.has(row.keeper));
  if (kept) return { keeperId: kept.keeper, confirmed: kept.confirmed, frozen: true };
  // `projects` arrives ordered most recently opened first.
  return { keeperId: projects[0]!.project_id, confirmed: false, frozen: false };
}

/** Aggregates the plan records per account: counts only, no names or emails. */
async function accountPlanFacts(accountId: string): Promise<Record<string, unknown>> {
  const [facts] = await db.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*)::int FROM kortix.account_memberships WHERE account_id = ${accountId}) AS members,
      (SELECT count(*)::int FROM kortix.account_groups WHERE account_id = ${accountId}) AS groups,
      (SELECT count(*)::int FROM kortix.roles WHERE account_id = ${accountId}) AS custom_roles,
      (SELECT count(*)::int FROM kortix.role_assignments WHERE account_id = ${accountId} AND scope_type = 'account') AS account_grants,
      (SELECT count(*)::int FROM kortix.account_secret_resources WHERE account_id = ${accountId} AND project_id IS NULL) AS account_secrets,
      (SELECT count(*)::int FROM kortix.account_github_installations WHERE account_id = ${accountId}) AS github_installations,
      (SELECT count(*)::int FROM kortix.account_github_user_tokens WHERE account_id = ${accountId}) AS github_user_tokens,
      (SELECT count(*)::int FROM kortix.claude_subscription_logins WHERE account_id = ${accountId}) AS claude_logins,
      (SELECT count(*)::int FROM kortix.account_tokens WHERE account_id = ${accountId} AND project_id IS NULL AND status = 'active') AS unbound_tokens_staying,
      (SELECT count(*)::int FROM kortix.api_keys WHERE account_id = ${accountId}) AS api_keys_staying,
      (SELECT count(*)::int FROM kortix.oauth_clients WHERE account_id = ${accountId}) AS oauth_clients_staying,
      (SELECT count(*)::int FROM kortix.billing_customers WHERE account_id = ${accountId}) AS billing_customers,
      (SELECT count(*)::int FROM kortix.credit_purchases WHERE account_id = ${accountId} AND status = 'completed') AS completed_purchases,
      (SELECT count(*)::int FROM kortix.credit_accounts WHERE account_id = ${accountId} AND stripe_subscription_id IS NOT NULL) AS stripe_subscriptions,
      (SELECT count(*)::int FROM kortix.credit_accounts WHERE account_id = ${accountId}
          AND (revenuecat_subscription_id IS NOT NULL OR revenuecat_customer_id IS NOT NULL)) AS revenuecat_subscriptions,
      (SELECT count(*)::int FROM kortix.credit_accounts WHERE account_id = ${accountId}
          AND (coalesce(tier, 'free') NOT IN ('free', 'none') OR lifetime_purchased_precise > 0)) AS paid_plan_or_purchase,
      (SELECT count(*)::int FROM kortix.enterprise_contracts WHERE account_id = ${accountId}) AS enterprise_contracts`);
  return facts ?? {};
}

async function projectPlanFacts(projectId: string, accountId: string): Promise<Record<string, unknown>> {
  const [facts] = await db.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*)::int FROM kortix.apps WHERE project_id = ${projectId}) AS apps,
      (SELECT count(*)::int FROM kortix.role_assignments WHERE account_id = ${accountId} AND scope_type = 'project' AND scope_id = ${projectId}) AS project_grants,
      (SELECT count(*)::int FROM kortix.account_invitations WHERE account_id = ${accountId} AND accepted_at IS NULL AND expires_at > now()
          AND bootstrap_grants @> ${JSON.stringify([{ project_id: projectId }])}::jsonb) AS invites_to_split`);
  return facts ?? {};
}

/** Plan one legacy account: upsert a ledger row per non-keeper project. */
async function planAccount(accountId: string): Promise<{ planned: number; held: number; skipped: number }> {
  const projects = await db.execute<AccountProject>(sql`
    SELECT project_id::text, last_opened_at::text, created_at::text FROM kortix.projects
     WHERE account_id = ${accountId} AND status = 'active'
     ORDER BY last_opened_at DESC NULLS LAST, created_at DESC, project_id`);
  const counts = { planned: 0, held: 0, skipped: 0 };
  if (projects.length < 2) return counts;
  const { keeperId, confirmed, frozen } = await keeperFor(accountId, projects);
  const facts = await accountPlanFacts(accountId);
  // Every paid source billing knows: a completed purchase (Stripe or RevenueCat),
  // a Stripe or RevenueCat subscription, a paid plan however it was set
  // (Stripe, RevenueCat, an admin, a legacy tier key), purchased credit, and an
  // enterprise contract.
  const paying = ['completed_purchases', 'stripe_subscriptions', 'revenuecat_subscriptions', 'paid_plan_or_purchase', 'enterprise_contracts']
    .some((key) => Number(facts[key]) > 0);
  const phase: WorkspaceSplitPhase = paying && !confirmed ? 'held' : 'planned';
  const open = await db.execute<{ run_id: string; project_id: string; phase: WorkspaceSplitPhase }>(sql`
    SELECT run_id::text, project_id::text, phase FROM kortix.workspace_split_runs
     WHERE from_account_id = ${accountId} AND phase IN ('planned', 'held', 'storage_copied', 'reversed')`);
  const byProject = new Map(open.map((row) => [row.project_id, row]));
  const activeIds = new Set(projects.map((p) => p.project_id));

  for (const project of projects) {
    if (project.project_id === keeperId) continue;
    const existing = byProject.get(project.project_id);
    if (existing?.phase === 'reversed' || existing?.phase === 'storage_copied') continue;
    const plan = {
      keeper_project_id: keeperId,
      keeper_confirmed: confirmed,
      keeper_frozen: frozen,
      last_opened_at: project.last_opened_at,
      held_reason: phase === 'held' ? 'account_has_billing' : null,
      account: facts,
      project: await projectPlanFacts(project.project_id, accountId),
      planned_at: new Date().toISOString(),
    };
    if (existing) {
      await db.execute(sql`UPDATE kortix.workspace_split_runs SET plan = ${JSON.stringify(plan)}::jsonb, phase = ${phase}, updated_at = now()
        WHERE run_id = ${existing.run_id} AND phase IN ('planned', 'held')`);
    } else {
      await db.insert(workspaceSplitRuns).values({ projectId: project.project_id, fromAccountId: accountId, phase, mode: 'dry_run', plan });
    }
    counts[phase === 'held' ? 'held' : 'planned'] += 1;
  }
  // The keeper and projects that left need no move.
  for (const row of open) {
    if ((row.phase === 'planned' || row.phase === 'held') && (row.project_id === keeperId || !activeIds.has(row.project_id))) {
      await db.execute(sql`UPDATE kortix.workspace_split_runs SET phase = 'skipped', updated_at = now() WHERE run_id = ${row.run_id}`);
      counts.skipped += 1;
    }
  }
  return counts;
}

/**
 * The plan pass: every account with 2+ active projects gets its ledger rows;
 * rows of accounts that are no longer legacy are skipped. Moves nothing.
 */
export async function planWorkspaceSplits(options: { accountIds?: string[] } = {}): Promise<{ accounts: number; planned: number; held: number; skipped: number }> {
  const filter = options.accountIds ? sql`AND account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(options.accountIds)}::jsonb))` : sql``;
  const legacy = await db.execute<{ account_id: string }>(sql`
    SELECT account_id::text FROM kortix.projects WHERE status = 'active' ${filter}
     GROUP BY account_id HAVING count(*) > 1 ORDER BY account_id`);
  const totals = { accounts: legacy.length, planned: 0, held: 0, skipped: 0 };
  for (const { account_id } of legacy) {
    const counts = await planAccount(account_id);
    totals.planned += counts.planned;
    totals.held += counts.held;
    totals.skipped += counts.skipped;
  }
  const stale = await db.execute(sql`
    UPDATE kortix.workspace_split_runs r SET phase = 'skipped', updated_at = now()
     WHERE r.phase IN ('planned', 'held') ${options.accountIds ? sql`AND r.from_account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(options.accountIds)}::jsonb))` : sql``}
       AND (SELECT count(*) FROM kortix.projects p WHERE p.account_id = r.from_account_id AND p.status = 'active') < 2
    RETURNING r.run_id`);
  totals.skipped += stale.length;
  return totals;
}

export interface ApplyDeps {
  siteStorage?: SiteStorage;
}

export type ApplyOutcome = 'done' | 'busy' | 'skipped' | 'error' | 'failed';

async function recordFailure(run: RunRow, error: unknown): Promise<ApplyOutcome> {
  // Drizzle wraps a database error ("Failed query: …"); the cause names it.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  const message = cause ?? (error instanceof Error ? error.message : String(error));
  const skip = error instanceof ProjectSplitError && (error.code === 'not_legacy' || error.code === 'project_missing');
  const failed = !skip && run.attempts >= WORKSPACE_SPLIT_MAX_ATTEMPTS;
  await db.execute(sql`UPDATE kortix.workspace_split_runs
    SET error = ${message.slice(0, 2000)}, heartbeat_at = NULL, updated_at = now(),
        phase = ${skip ? 'skipped' : failed ? 'failed' : run.phase}
    WHERE run_id = ${run.runId} AND attempts = ${run.attempts}`);
  logger.warn('[workspace-split] run did not complete', { runId: run.runId, projectId: run.projectId, attempt: run.attempts, error: message });
  return skip ? 'skipped' : failed ? 'failed' : 'error';
}

/**
 * Apply one ledger row: claim the lease, copy the site blobs, then split the
 * project in one transaction. Safe to call again after any crash.
 */
export async function applyWorkspaceSplitRun(runId: string, deps: ApplyDeps = {}): Promise<ApplyOutcome> {
  const [claimed] = await db.execute<{ run_id: string }>(sql`
    UPDATE kortix.workspace_split_runs
       SET heartbeat_at = now(), attempts = attempts + 1, mode = 'apply', updated_at = now(),
           to_account_id = COALESCE(to_account_id, ${randomUUID()}::uuid)
     WHERE run_id = ${runId} AND phase IN ('planned', 'storage_copied')
       AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => ${WORKSPACE_SPLIT_LEASE_MS / 1000}))
    RETURNING run_id`);
  if (!claimed) return 'busy';
  let [run] = await db.select().from(workspaceSplitRuns).where(eq(workspaceSplitRuns.runId, runId));
  if (!run?.toAccountId) return 'busy';
  const toAccountId = run.toAccountId;
  try {
    if (run.phase === 'planned') {
      const blobs = await copyProjectSiteBlobs({ projectId: run.projectId, fromAccountId: run.fromAccountId, toAccountId }, deps.siteStorage);
      await db.execute(sql`UPDATE kortix.workspace_split_runs
        SET phase = 'storage_copied', heartbeat_at = now(), updated_at = now(),
            plan = plan || ${JSON.stringify({ site_blobs_copied: blobs.copied.length, site_blobs_missing: blobs.missing.length })}::jsonb
        WHERE run_id = ${runId} AND attempts = ${run.attempts}`);
      run = { ...run, phase: 'storage_copied' };
    }
    const attempts = run.attempts;
    await db.transaction(async (tx) => {
      const [locked] = await tx.execute<{ phase: string; attempts: number }>(sql`
        SELECT phase, attempts FROM kortix.workspace_split_runs WHERE run_id = ${runId} FOR UPDATE`);
      // Fencing: a newer claim (a reclaimed lease) owns the run now.
      if (locked?.phase !== 'storage_copied' || locked.attempts !== attempts) throw new Error('lease_lost');
      const grantsBefore = await projectGrantCounts(tx, run!.fromAccountId, run!.projectId);
      const copied = await splitProjectIntoNewAccount(tx, { projectId: run!.projectId, fromAccountId: run!.fromAccountId, toAccountId });
      await tx.execute(sql`UPDATE kortix.workspace_split_runs
        SET phase = 'done', copied_ids = ${JSON.stringify(copied)}::jsonb, error = NULL, heartbeat_at = NULL,
            completed_at = now(), updated_at = now(), plan = plan || ${JSON.stringify({ grants_before: grantsBefore })}::jsonb
        WHERE run_id = ${runId}`);
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'lease_lost') return 'busy';
    return recordFailure(run, error);
  }
  // The new account's wallet (Free, 0 credits, never the free grant) committed
  // with the split: splitProjectIntoNewAccount writes its credit_accounts row.
  // design.md §3.2 C1: after a move, each account's expand rows carry its
  // workspace id (NULL while the source is still split_pending).
  await fillAccountWorkspaceIds(run.fromAccountId, toAccountId);
  return 'done';
}

/** Undo a `done` run (one project): see `reverseProjectSplit`. */
export async function reverseWorkspaceSplitRun(runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(workspaceSplitRuns).where(eq(workspaceSplitRuns.runId, runId)).for('update');
    if (!run) throw new ProjectSplitError('reverse_refused', 'Split run not found');
    if (run.phase !== 'done' || !run.toAccountId) throw new ProjectSplitError('reverse_refused', `Split run is ${run.phase}, not done`);
    await reverseProjectSplit(tx, {
      projectId: run.projectId, fromAccountId: run.fromAccountId, toAccountId: run.toAccountId,
      copied: run.copiedIds as unknown as SplitCopiedIds,
    });
    await tx.update(workspaceSplitRuns).set({ phase: 'reversed', updatedAt: new Date() }).where(eq(workspaceSplitRuns.runId, runId));
    return [run.fromAccountId, run.toAccountId] as const;
  }).then(([fromAccountId, toAccountId]) => fillAccountWorkspaceIds(fromAccountId, toAccountId));
}

/** kortix.workspace_fill_account for both accounts of a move (C1). */
async function fillAccountWorkspaceIds(fromAccountId: string, toAccountId: string): Promise<void> {
  await db.execute(sql`SELECT kortix.workspace_fill_account(${fromAccountId}::uuid), kortix.workspace_fill_account(${toAccountId}::uuid)`);
}

/**
 * An operator's second try after a reverse: the `reversed` run becomes
 * `planned` again, with no target account, so the next apply splits the
 * project into a fresh account. The account of the reversed move stays a
 * dormant record; its id is kept in `plan.reversed_to_account_ids`.
 * `reverse` alone never re-plans a project (the planner skips `reversed`).
 */
export async function reopenWorkspaceSplitRun(runId: string): Promise<void> {
  const [reopened] = await db.execute<{ run_id: string }>(sql`
    UPDATE kortix.workspace_split_runs
       SET phase = 'planned', mode = 'dry_run', to_account_id = NULL, copied_ids = '{}'::jsonb, attempts = 0,
           heartbeat_at = NULL, error = NULL, completed_at = NULL, updated_at = now(),
           plan = plan || jsonb_build_object('reversed_to_account_ids',
             COALESCE(plan->'reversed_to_account_ids', '[]'::jsonb) || to_jsonb(ARRAY[to_account_id::text]))
     WHERE run_id = ${runId} AND phase = 'reversed'
    RETURNING run_id`);
  if (!reopened) throw new ProjectSplitError('reverse_refused', 'Split run is not reversed');
}

/**
 * An owner's choice of the project that keeps the account and its billing.
 * Releases a `held` account: its other projects become `planned`.
 */
export async function confirmWorkspaceSplitKeeper(accountId: string, keeperProjectId: string): Promise<void> {
  const [project] = await db.execute<{ ok: boolean }>(sql`
    SELECT true AS ok FROM kortix.projects WHERE project_id = ${keeperProjectId} AND account_id = ${accountId} AND status = 'active'`);
  if (!project) throw new ProjectSplitError('project_missing', 'The keeper is not an active project of the account');
  const started = await db.execute(sql`SELECT 1 FROM kortix.workspace_split_runs
    WHERE from_account_id = ${accountId} AND phase IN ('storage_copied', 'done') AND plan->>'keeper_project_id' <> ${keeperProjectId}`);
  if (started.length) throw new ProjectSplitError('reverse_refused', 'A move of this account already started with another keeper');
  await planWorkspaceSplits({ accountIds: [accountId] });
  const marker = { keeper_project_id: keeperProjectId, keeper_confirmed: true };
  await db.execute(sql`UPDATE kortix.workspace_split_runs
    SET plan = plan || ${JSON.stringify(marker)}::jsonb, updated_at = now(),
        phase = CASE WHEN project_id = ${keeperProjectId} THEN 'skipped' WHEN phase = 'held' THEN 'planned' ELSE phase END
    WHERE from_account_id = ${accountId} AND phase IN ('planned', 'held')`);
  // The previous keeper now needs its own row.
  await planWorkspaceSplits({ accountIds: [accountId] });
}

const PLAN_EVERY_MS = 30 * 60_000;
const IDLE_MS = 60 * 60_000;
const DRY_RUN_EVERY_MS = 6 * 60 * 60_000;
const BACKLOG_MS = 60_000;
const APPLY_BATCH = 5;
let lastPlannedAt = 0;

/** Test seam: the next pass plans again. */
export function resetWorkspaceSplitPlanClock(): void {
  lastPlannedAt = 0;
}

export interface WorkspaceSplitTickResult {
  mode: WorkspaceSplitMode;
  planned: boolean;
  outcomes: Record<ApplyOutcome, number>;
  /** When the leader timer runs the next pass. */
  nextDelayMs: number;
}

/**
 * The worker tick (worker/jobs/workspace-split.ts, leader only). `dry_run`
 * plans; `apply` plans at most every 30 minutes and applies up to
 * APPLY_BATCH runs, the oldest-opened projects first (the active and paying
 * accounts go last).
 */
export async function processWorkspaceSplits(options: { mode?: WorkspaceSplitMode; deps?: ApplyDeps; batch?: number } = {}): Promise<WorkspaceSplitTickResult> {
  const mode = options.mode ?? (await workspaceSplitMode());
  const outcomes: Record<ApplyOutcome, number> = { done: 0, busy: 0, skipped: 0, error: 0, failed: 0 };
  if (mode === 'off') return { mode, planned: false, outcomes, nextDelayMs: IDLE_MS };
  let planned = false;
  if (mode === 'dry_run' || Date.now() - lastPlannedAt >= PLAN_EVERY_MS) {
    const totals = await planWorkspaceSplits();
    lastPlannedAt = Date.now();
    planned = true;
    logger.info('[workspace-split] plan pass', { mode, ...totals });
  }
  if (mode === 'dry_run') return { mode, planned, outcomes, nextDelayMs: DRY_RUN_EVERY_MS };
  const batch = options.batch ?? APPLY_BATCH;
  const runnable = await db.execute<{ run_id: string }>(sql`
    SELECT run_id::text FROM kortix.workspace_split_runs
     WHERE phase IN ('planned', 'storage_copied')
       AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => ${WORKSPACE_SPLIT_LEASE_MS / 1000}))
     ORDER BY (phase = 'storage_copied') DESC, plan->>'last_opened_at' ASC NULLS FIRST, created_at
     LIMIT ${batch + 1}`);
  for (const { run_id } of runnable.slice(0, batch)) {
    outcomes[await applyWorkspaceSplitRun(run_id, options.deps)] += 1;
  }
  return { mode, planned, outcomes, nextDelayMs: runnable.length > batch ? BACKLOG_MS : IDLE_MS };
}

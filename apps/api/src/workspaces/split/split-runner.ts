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
 *   held            the account pays (`kortix.account_is_paying`: a paid
 *                   plan, bought credits, an enterprise contract; a bare
 *                   Stripe subscription id never counts): its owner chooses
 *                   the keeper first (`confirmWorkspaceSplitKeeper`)
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
 * Keeper: the most active project of the account: the most `project_sessions`
 * created in the last KEEPER_ACTIVITY_DAYS days, then the most recently
 * opened (`last_opened_at DESC NULLS LAST`), then the newest created, then
 * `project_id`. It keeps the account, its credits, plan and Stripe customer.
 * The keeper is frozen once a move of the account started, or once an owner
 * confirmed it; until then each plan pass re-ranks it.
 *
 * Lease: a claim sets `heartbeat_at` and increments `attempts`; a run whose
 * heartbeat is older than LEASE_MS is reclaimable (a crash mid-run). The move
 * itself is one transaction, so a crash inside it moves nothing.
 *
 * After a run is `done` (each step is recorded in `plan`, and the tick retries
 * a step that did not finish):
 *
 *   plan.billing      `applySplitOffBilling` (C6): Free with the free-credit
 *                     exception, or the keeper's plan comped
 *   plan.repaired_at  the repair pass at completed_at + REPAIR_AFTER_MS: the
 *                     move's own idempotent UPDATEs again, for rows a request
 *                     that started before the move wrote with the old account,
 *                     then I2 for the run (design.md §3.1 row 32)
 *   owner emails      once the account's last move is done: one outbox row
 *                     per owner (`kortix.workspace_split_emails`), sent in
 *                     `apply` mode only (`owner-email.ts`)
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { platformSettings, workspaceSplitRuns } from '@kortix/db';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import type { SiteStorage } from '../../apps/static-site';
import {
  afterProjectMoved,
  copyProjectSiteBlobs,
  countRotatingLogins,
  moveOwnedRows,
  projectGrantCounts,
  ProjectSplitError,
  reverseProjectSplit,
  splitProjectIntoNewAccount,
  type SplitCopiedIds,
} from '../../projects/surface';
import {
  applySplitOffBilling,
  previewSplitOffBilling,
  reverseSplitOffBilling,
} from '../../billing/services/split-off-billing';
import { checkSplitRunsMoved } from './invariants';
import { deliverSplitOwnerEmails, sendSplitOwnerEmails, type SendEmail } from './owner-email';

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

/** The activity window of the keeper rule: sessions created in the last 30 days. */
export const KEEPER_ACTIVITY_DAYS = 30;

type AccountProject = { project_id: string; last_opened_at: string | null; created_at: string; recent_sessions: number };

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
  // `projects` arrives ordered most active first (the keeper rule).
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
  const billing = await previewSplitOffBilling(accountId);
  return {
    ...(facts ?? {}),
    // A login one side keeps; the other side reconnects (design.md §3.1 row 5).
    rotating_logins: await countRotatingLogins(accountId),
    // What each split-off of this account gets (C6), credits per split-off.
    split_off_billing: { kind: billing.kind, comped_until: billing.compedUntil, credits: billing.credits },
  };
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

type HoldReason = 'account_has_identity_provider' | 'account_has_billing';

/**
 * Why a move out of `accountId` must wait, or null. The planner and the move
 * transaction both ask, so an account that changes between two plan passes
 * never moves on a stale plan.
 *   - account_has_identity_provider: an SSO provider or a live SCIM token. The
 *     split-off would copy the members but not the IdP, so SSO enforcement and
 *     SCIM deprovisioning would stop at the keeper. Held until the split
 *     carries identity (design.md §3.1); confirming the keeper does not
 *     release it.
 *   - account_has_billing: the one paying rule (C6, kortix.account_is_paying)
 *     and no keeper confirmed by an owner.
 */
async function holdReasonFor(
  executor: Pick<typeof db, 'execute'>,
  accountId: string,
  keeperConfirmed: boolean,
): Promise<HoldReason | null> {
  const [row] = await executor.execute<{ idp: boolean; paying: boolean }>(sql`
    SELECT (EXISTS (SELECT 1 FROM kortix.account_sso_providers WHERE account_id = ${accountId})
             OR EXISTS (SELECT 1 FROM kortix.scim_tokens WHERE account_id = ${accountId} AND revoked_at IS NULL)) AS idp,
           kortix.account_is_paying(${accountId}) AS paying`);
  if (row?.idp) return 'account_has_identity_provider';
  if (row?.paying && !keeperConfirmed) return 'account_has_billing';
  return null;
}

/** Plan one legacy account: upsert a ledger row per non-keeper project. */
async function planAccount(accountId: string): Promise<{ planned: number; held: number; skipped: number }> {
  // The keeper rule, most active first. idx_project_sessions_project serves
  // the per-project count; a legacy account holds a handful of projects.
  const projects = await db.execute<AccountProject>(sql`
    SELECT p.project_id::text, p.last_opened_at::text, p.created_at::text,
           (SELECT count(*)::int FROM kortix.project_sessions s
             WHERE s.project_id = p.project_id
               AND s.created_at > now() - make_interval(days => ${KEEPER_ACTIVITY_DAYS})) AS recent_sessions
      FROM kortix.projects p
     WHERE p.account_id = ${accountId} AND p.status = 'active'
     ORDER BY recent_sessions DESC, p.last_opened_at DESC NULLS LAST, p.created_at DESC, p.project_id`);
  const counts = { planned: 0, held: 0, skipped: 0 };
  if (projects.length < 2) return counts;
  const { keeperId, confirmed, frozen } = await keeperFor(accountId, projects);
  const facts = await accountPlanFacts(accountId);
  // The one paying rule (C6, kortix.account_is_paying): a paid plan however it
  // was set, bought credits, a completed purchase, an active enterprise
  // contract. A Stripe subscription id on a Free account is stale and pays
  // nothing (149 legacy prod accounts carry one).
  const holdReason = await holdReasonFor(db, accountId, confirmed);
  const phase: WorkspaceSplitPhase = holdReason ? 'held' : 'planned';
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
      recent_sessions: project.recent_sessions,
      keeper_recent_sessions: projects.find((p) => p.project_id === keeperId)?.recent_sessions ?? null,
      held_reason: holdReason,
      account: facts,
      project: await projectPlanFacts(project.project_id, accountId),
      planned_at: new Date().toISOString(),
    };
    if (existing) {
      // Merge, never replace: a reopened run keeps `reversed_to_account_ids`.
      await db.execute(sql`UPDATE kortix.workspace_split_runs SET plan = plan || ${JSON.stringify(plan)}::jsonb, phase = ${phase}, updated_at = now()
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
export async function planWorkspaceSplits(options: { accountIds?: string[] } = {}): Promise<{ accounts: number; planned: number; held: number; skipped: number; stale_flags_cleared: number }> {
  const filter = options.accountIds ? sql`AND account_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(options.accountIds)}::jsonb))` : sql``;
  const staleFlags = await clearStaleSplitPending(filter);
  const legacy = await db.execute<{ account_id: string }>(sql`
    SELECT account_id::text FROM kortix.projects WHERE status = 'active' ${filter}
     GROUP BY account_id HAVING count(*) > 1 ORDER BY account_id`);
  const totals = { accounts: legacy.length, planned: 0, held: 0, skipped: 0, stale_flags_cleared: staleFlags };
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

/**
 * A `split_pending` flag on the only active project of an account (design.md
 * §3.1 row 27). The projects_split_pending_sync trigger keeps the flag right
 * for every write after its migration; this clears the rows that went stale
 * before it (an archived sibling), once, and fills their workspace ids.
 */
async function clearStaleSplitPending(filter: ReturnType<typeof sql>): Promise<number> {
  const cleared = await db.execute<{ account_id: string }>(sql`
    UPDATE kortix.projects p SET split_pending = false, updated_at = now()
     WHERE p.split_pending AND p.status = 'active' ${filter}
       AND (SELECT count(*) FROM kortix.projects q WHERE q.account_id = p.account_id AND q.status = 'active') = 1
    RETURNING p.account_id::text`);
  for (const { account_id } of cleared) await fillWorkspaceIds([account_id]);
  return cleared.length;
}

export interface ApplyDeps {
  siteStorage?: SiteStorage;
  /** The owner email transport (test seam). Default: lib/email/transport. */
  sendEmail?: SendEmail;
  /**
   * The split mode the owner emails obey: they go out in `apply` only.
   * Default: `workspaceSplitMode()` (the platform setting, else the env).
   */
  mode?: WorkspaceSplitMode;
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
    const moved = await db.transaction(async (tx) => {
      const [locked] = await tx.execute<{ phase: string; attempts: number }>(sql`
        SELECT phase, attempts FROM kortix.workspace_split_runs WHERE run_id = ${runId} FOR UPDATE`);
      // Fencing: a newer claim (a reclaimed lease) owns the run now.
      if (locked?.phase !== 'storage_copied' || locked.attempts !== attempts) throw new Error('lease_lost');
      // The plan may be up to one plan interval old: re-check the hold under
      // the run lock. A held run moves nothing; the copied site blobs are
      // copies and stay harmless.
      const holdReason = await holdReasonFor(tx, run!.fromAccountId, (run!.plan as Record<string, unknown>)?.keeper_confirmed === true);
      if (holdReason) {
        await tx.execute(sql`UPDATE kortix.workspace_split_runs
          SET phase = 'held', heartbeat_at = NULL, updated_at = now(),
              plan = plan || ${JSON.stringify({ held_reason: holdReason })}::jsonb
          WHERE run_id = ${runId}`);
        return 'held' as const;
      }
      const grantsBefore = await projectGrantCounts(tx, run!.fromAccountId, run!.projectId);
      const copied = await splitProjectIntoNewAccount(tx, { projectId: run!.projectId, fromAccountId: run!.fromAccountId, toAccountId });
      await tx.execute(sql`UPDATE kortix.workspace_split_runs
        SET phase = 'done', copied_ids = ${JSON.stringify(copied)}::jsonb, error = NULL, heartbeat_at = NULL,
            completed_at = now(), updated_at = now(), plan = plan || ${JSON.stringify({ grants_before: grantsBefore })}::jsonb
        WHERE run_id = ${runId}`);
      return 'moved' as const;
    });
    if (moved === 'held') return 'skipped';
  } catch (error) {
    if (error instanceof Error && error.message === 'lease_lost') return 'busy';
    return recordFailure(run, error);
  }
  await afterMoveCommitted({ runId, projectId: run.projectId, fromAccountId: run.fromAccountId, toAccountId }, deps);
  return 'done';
}

type MovedRun = { runId: string; projectId: string; fromAccountId: string; toAccountId: string };

/**
 * After a move committed. Each step is safe to run again, and the tick
 * retries a step that failed here (`finishDoneRuns`):
 *   1. the caches keyed by the old account (IAM on every replica, model defaults);
 *   2. the new account's workspace ids (C1);
 *   3. its billing (C6), recorded in plan.billing;
 *   4. when this was the account's last move: the keeper's workspace ids and
 *      the owner emails.
 */
async function afterMoveCommitted(run: MovedRun, deps: ApplyDeps): Promise<void> {
  await afterProjectMoved(run);
  await bustAccounts([run.fromAccountId, run.toAccountId]);
  await fillWorkspaceIds([run.toAccountId]);
  await applyRunBilling(run);
  await finishAccountIfLast(run.fromAccountId, deps);
}

/**
 * The wallet key of a run's billing: the run id and its target account. A
 * reopened run splits into a fresh account, and credit_ledger.stripe_event_id
 * is unique across accounts, so a key of the run alone would replay the
 * dormant account's grant and leave the fresh one with nothing.
 */
function billingRunKey(runId: string, toAccountId: string): string {
  return `${runId}:${toAccountId}`;
}

/** `applySplitOffBilling` for one done run; the result goes to plan.billing. A failure stays for the tick to retry. */
async function applyRunBilling(run: MovedRun): Promise<boolean> {
  try {
    const billing = await applySplitOffBilling({
      runId: billingRunKey(run.runId, run.toAccountId), sourceAccountId: run.fromAccountId, newAccountId: run.toAccountId,
    });
    await db.execute(sql`UPDATE kortix.workspace_split_runs
      SET plan = plan || jsonb_build_object('billing', ${JSON.stringify(billing)}::jsonb), updated_at = now()
      WHERE run_id = ${run.runId} AND phase = 'done'`);
    return true;
  } catch (error) {
    await db.execute(sql`UPDATE kortix.workspace_split_runs
      SET plan = plan || jsonb_build_object('billing_attempts', COALESCE((plan->>'billing_attempts')::int, 0) + 1), updated_at = now()
      WHERE run_id = ${run.runId}`);
    logger.warn('[workspace-split] split-off billing did not apply', {
      runId: run.runId, error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * When no move of `fromAccountId` is open any more and it holds one project:
 * the keeper's and every split-off's workspace ids (C1), then the owner
 * emails (C9). Only after an apply: a dry run never reaches here.
 */
async function finishAccountIfLast(fromAccountId: string, deps: ApplyDeps): Promise<void> {
  // The email states each split-off's plan, so it waits until every done run
  // has its billing recorded (finishDoneRuns retries both).
  const [state] = await db.execute<{ open: number; active: number; targets: string[] }>(sql`
    SELECT (SELECT count(*)::int FROM kortix.workspace_split_runs
             WHERE from_account_id = ${fromAccountId}
               AND (phase IN ('planned', 'held', 'storage_copied') OR (phase = 'done' AND NOT (plan ? 'billing')))) AS open,
           (SELECT count(*)::int FROM kortix.projects WHERE account_id = ${fromAccountId} AND status = 'active') AS active,
           COALESCE((SELECT jsonb_agg(to_account_id::text) FROM kortix.workspace_split_runs
             WHERE from_account_id = ${fromAccountId} AND phase = 'done'), '[]'::jsonb) AS targets`);
  if (!state || state.open > 0 || state.active > 1 || !state.targets.length) return;
  await fillWorkspaceIds([fromAccountId, ...state.targets]);
  await sendSplitOwnerEmails(fromAccountId, deps.mode ?? (await workspaceSplitMode()), deps.sendEmail);
}

export const REPAIR_AFTER_MS = 120_000;

/**
 * The repair pass of one done run (design.md §3.1 row 32): a request that
 * started before the move (a session create, a prompt enqueue) can commit a
 * row with the old account after it. Re-run the move's own idempotent
 * UPDATEs for the project, then check I2 for the run. Recorded in
 * plan.repaired_at / repaired_rows / repair_i2_violations. A run whose project
 * left its split-off account (a reverse, a later transfer) is not touched.
 */
export async function repairWorkspaceSplitRun(runId: string): Promise<{ rows: Record<string, number>; i2Violations: number } | null> {
  const repaired = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(workspaceSplitRuns).where(eq(workspaceSplitRuns.runId, runId)).for('update');
    if (!run || run.phase !== 'done' || !run.toAccountId) return null;
    const [project] = await tx.execute<{ account_id: string }>(sql`
      SELECT account_id::text FROM kortix.projects WHERE project_id = ${run.projectId} FOR UPDATE`);
    const copied = run.copiedIds as unknown as SplitCopiedIds;
    const moved = { projectId: run.projectId, fromAccountId: run.fromAccountId, toAccountId: run.toAccountId };
    const rows = project?.account_id === run.toAccountId
      ? (await moveOwnedRows(tx, moved, { groups: copied.groups ?? {}, roles: copied.roles ?? {} })).rows
      : {};
    await tx.execute(sql`UPDATE kortix.workspace_split_runs
      SET plan = plan || jsonb_build_object('repaired_at', now(), 'repaired_rows', ${JSON.stringify(rows)}::jsonb), updated_at = now()
      WHERE run_id = ${runId}`);
    return { run: moved, rows };
  });
  if (!repaired) return null;
  if (Object.keys(repaired.rows).length) {
    await afterProjectMoved(repaired.run);
    await fillWorkspaceIds([repaired.run.toAccountId]);
    logger.warn('[workspace-split] repair moved rows written during the move', { runId, rows: repaired.rows });
  }
  const i2 = await checkSplitRunsMoved([runId]);
  await db.execute(sql`UPDATE kortix.workspace_split_runs
    SET plan = plan || jsonb_build_object('repair_i2_violations', ${i2.violations}::int), updated_at = now()
    WHERE run_id = ${runId}`);
  if (!i2.ok) logger.warn('[workspace-split] I2 after the repair pass', { runId, sample: i2.sample });
  return { rows: repaired.rows, i2Violations: i2.violations };
}

const BILLING_MAX_ATTEMPTS = 5;

/**
 * The done-run follow-ups the tick owns: the billing that did not apply, the
 * repair pass when it is due, and the accounts whose owner emails are not all
 * sent. Returns when the next repair is due (ms from now), or null.
 */
async function finishDoneRuns(deps: ApplyDeps): Promise<number | null> {
  const unbilled = await db.execute<{ run_id: string; project_id: string; from_account_id: string; to_account_id: string }>(sql`
    SELECT run_id::text, project_id::text, from_account_id::text, to_account_id::text FROM kortix.workspace_split_runs
     WHERE phase = 'done' AND NOT (plan ? 'billing') AND COALESCE((plan->>'billing_attempts')::int, 0) < ${BILLING_MAX_ATTEMPTS}
     ORDER BY completed_at LIMIT 20`);
  for (const run of unbilled) {
    await applyRunBilling({ runId: run.run_id, projectId: run.project_id, fromAccountId: run.from_account_id, toAccountId: run.to_account_id });
  }
  const due = await db.execute<{ run_id: string }>(sql`
    SELECT run_id::text FROM kortix.workspace_split_runs
     WHERE phase = 'done' AND NOT (plan ? 'repaired_at')
       AND completed_at <= now() - make_interval(secs => ${REPAIR_AFTER_MS / 1000})
     ORDER BY completed_at LIMIT 20`);
  for (const { run_id } of due) await repairWorkspaceSplitRun(run_id);
  // Accounts whose last move is done and whose owner emails are not
  // enqueued yet (the finish after the move did not run to the end).
  const unfinished = await db.execute<{ from_account_id: string }>(sql`
    SELECT DISTINCT r.from_account_id::text FROM kortix.workspace_split_runs r
     WHERE r.phase = 'done' AND r.updated_at > now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM kortix.workspace_split_runs o
                        WHERE o.from_account_id = r.from_account_id AND o.phase IN ('planned', 'held', 'storage_copied'))
       AND NOT EXISTS (SELECT 1 FROM kortix.workspace_split_emails e WHERE e.from_account_id = r.from_account_id)
     LIMIT 20`);
  for (const { from_account_id } of unfinished) await finishAccountIfLast(from_account_id, deps);
  // The outbox: due rows, failed rows past their backoff, expired leases.
  await deliverSplitOwnerEmails(deps.mode ?? (await workspaceSplitMode()), { send: deps.sendEmail });
  const [next] = await db.execute<{ ms: number | null }>(sql`
    SELECT (extract(epoch FROM min(completed_at) + make_interval(secs => ${REPAIR_AFTER_MS / 1000}) - now()) * 1000)::bigint AS ms
      FROM kortix.workspace_split_runs WHERE phase = 'done' AND NOT (plan ? 'repaired_at')`);
  return next?.ms === null || next?.ms === undefined ? null : Math.max(1_000, Number(next.ms));
}

/** Undo a `done` run (one project): see `reverseProjectSplit`. */
export async function reverseWorkspaceSplitRun(runId: string): Promise<void> {
  const reversed = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(workspaceSplitRuns).where(eq(workspaceSplitRuns.runId, runId)).for('update');
    if (!run) throw new ProjectSplitError('reverse_refused', 'Split run not found');
    if (run.phase !== 'done' || !run.toAccountId) throw new ProjectSplitError('reverse_refused', `Split run is ${run.phase}, not done`);
    await reverseProjectSplit(tx, {
      projectId: run.projectId, fromAccountId: run.fromAccountId, toAccountId: run.toAccountId,
      copied: run.copiedIds as unknown as SplitCopiedIds,
    });
    await tx.update(workspaceSplitRuns).set({ phase: 'reversed', updatedAt: new Date() }).where(eq(workspaceSplitRuns.runId, runId));
    return { runId, projectId: run.projectId, fromAccountId: run.fromAccountId, toAccountId: run.toAccountId, billed: Boolean((run.plan as Record<string, unknown>).billing) };
  });
  // The dormant split-off keeps no comp and no split-off credits (C6). The
  // reverse above already refused an account that took money.
  if (reversed.billed) {
    await reverseSplitOffBilling({ runId: reversed.runId, newAccountId: reversed.toAccountId });
  }
  await afterProjectMoved(reversed);
  await bustAccounts([reversed.fromAccountId, reversed.toAccountId]);
  await fillWorkspaceIds([reversed.fromAccountId, reversed.toAccountId]);
}

/** kortix.workspace_fill_account for each account (C1): its expand rows carry its live workspace id. */
async function fillWorkspaceIds(accountIds: string[]): Promise<void> {
  for (const accountId of new Set(accountIds)) {
    await db.execute(sql`SELECT kortix.workspace_fill_account(${accountId}::uuid)`);
  }
}

/**
 * The IAM engine's workspace facts and decision caches of each account, on
 * every replica (C3: a split changes which workspace a membership reaches).
 * A cache bust failure leaves the 15 s TTL backstop.
 */
async function bustAccounts(accountIds: string[]): Promise<void> {
  try {
    const { invalidateWorkspaceFactsForAccount } = await import('../../iam/workspace-facts');
    const { invalidateIamCacheForAccount } = await import('../../iam/cache-invalidation');
    for (const accountId of new Set(accountIds)) {
      invalidateWorkspaceFactsForAccount(accountId);
      await invalidateIamCacheForAccount(accountId);
    }
  } catch (error) {
    logger.warn('[workspace-split] IAM cache bust failed', {
      account_ids: accountIds,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
           -- The reversed move's billing record names the dormant account: drop it,
           -- so the billing retry and the owner-email gate wait for the new one.
           plan = (plan - 'billing' - 'billing_attempts') || jsonb_build_object('reversed_to_account_ids',
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

/**
 * The dry-run report: aggregates over the runs still to apply (`planned`,
 * `held`), counts and credit totals only, never an id or a name. What an
 * operator reviews before switching to `apply` (split-runbook.md).
 */
export async function workspaceSplitReport(): Promise<Record<string, number>> {
  const [row] = await db.execute<Record<string, number>>(sql`
    WITH runs AS (
      SELECT from_account_id, phase, plan FROM kortix.workspace_split_runs WHERE phase IN ('planned', 'held')
    ), accounts AS (
      SELECT DISTINCT ON (from_account_id) from_account_id, plan->'account' AS facts FROM runs ORDER BY from_account_id
    )
    SELECT
      (SELECT count(*)::int FROM accounts) AS accounts,
      (SELECT count(*)::int FROM runs) AS projects_to_move,
      (SELECT count(*)::int FROM runs WHERE phase = 'held') AS projects_held,
      (SELECT count(DISTINCT from_account_id)::int FROM runs WHERE phase = 'held') AS accounts_held,
      (SELECT count(*)::int FROM runs WHERE plan->'account'->'split_off_billing'->>'kind' = 'free') AS split_offs_free,
      (SELECT count(*)::int FROM runs WHERE plan->'account'->'split_off_billing'->>'kind' = 'comped') AS split_offs_comped,
      (SELECT COALESCE(sum((plan->'account'->'split_off_billing'->>'credits')::numeric) FILTER (WHERE plan->'account'->'split_off_billing'->>'kind' = 'free'), 0)::int FROM runs) AS free_grant_credits_total,
      (SELECT COALESCE(sum((plan->'account'->'split_off_billing'->>'credits')::numeric) FILTER (WHERE plan->'account'->'split_off_billing'->>'kind' = 'comped'), 0)::int FROM runs) AS comp_credits_total,
      (SELECT COALESCE(sum((facts->>'rotating_logins')::int), 0)::int FROM accounts) AS rotating_logins,
      (SELECT COALESCE(sum((facts->>'unbound_tokens_staying')::int), 0)::int FROM accounts) AS unbound_tokens_staying,
      (SELECT COALESCE(sum((facts->>'api_keys_staying')::int), 0)::int FROM accounts) AS api_keys_staying,
      (SELECT COALESCE(sum((facts->>'oauth_clients_staying')::int), 0)::int FROM accounts) AS oauth_clients_staying,
      (SELECT COALESCE(sum((facts->>'members')::int), 0)::int FROM accounts) AS members_in_accounts`);
  return row ?? {};
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
  const deps: ApplyDeps = { ...options.deps, mode };
  const nextRepairMs = await finishDoneRuns(deps);
  const batch = options.batch ?? APPLY_BATCH;
  const runnable = await db.execute<{ run_id: string }>(sql`
    SELECT run_id::text FROM kortix.workspace_split_runs
     WHERE phase IN ('planned', 'storage_copied')
       AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => ${WORKSPACE_SPLIT_LEASE_MS / 1000}))
     ORDER BY (phase = 'storage_copied') DESC, plan->>'last_opened_at' ASC NULLS FIRST, created_at
     LIMIT ${batch + 1}`);
  for (const { run_id } of runnable.slice(0, batch)) {
    outcomes[await applyWorkspaceSplitRun(run_id, deps)] += 1;
  }
  // A run that finished now is repaired REPAIR_AFTER_MS later: come back then.
  const repairDue = outcomes.done > 0 ? REPAIR_AFTER_MS : nextRepairMs;
  const nextDelayMs = Math.min(runnable.length > batch ? BACKLOG_MS : IDLE_MS, repairDue ?? IDLE_MS);
  return { mode, planned, outcomes, nextDelayMs };
}

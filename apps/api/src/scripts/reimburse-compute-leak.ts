#!/usr/bin/env bun
/**
 * Org-wide reimbursement for the sandbox auto-stop / compute over-billing leak.
 *
 * Background: idle sandboxes never auto-stopped and their compute meter never
 * closed, so accounts were billed for wall-clock long after their last real
 * activity (see projects/sandbox-reaper.ts for the fix). This script makes the
 * affected accounts whole.
 *
 * Policy (decided): FULL refund of every AFFECTED (leaked) compute session —
 * not just the overage portion. A session is "affected" if it was billed past
 * `lastMeaningfulActivity + grace` (default 15 min), where lastMeaningful =
 * max(last LLM call in usage_events, the session's creation). That flags every
 * session the auto-stop bug touched (including the still-`active` phantom rows)
 * while excluding clean short sessions. The refund for each is its FULL
 * `cost_usd`.
 *
 * Deterministic + idempotent:
 *   - the affected set + amounts are computed purely from the DB (no provider
 *     calls), so a dry-run and the apply run agree.
 *   - refunds are keyed `compute_refund:v1:<accountId>` and written via
 *     grantCredits(..., stripeEventId=<key>), which lands on the UNIQUE
 *     credit_ledger.stripe_event_id index — re-running can never double-pay.
 *
 * Usage (run by a human, with prod env):
 *   dotenvx run -f apps/api/.env.prod -- bun apps/api/src/scripts/reimburse-compute-leak.ts            # dry-run report
 *   dotenvx run -f apps/api/.env.prod -- bun apps/api/src/scripts/reimburse-compute-leak.ts --apply    # close affected active rows + issue refunds
 *   ... [--ttl-minutes 15] [--account <uuid>] [--project <uuid>]
 *
 * SAFETY: default is a read-only dry-run. `--apply` mutates billing (closes
 * compute rows + grants credits). Review the dry-run report first.
 */

import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { grantCredits } from '../billing/services/credits';

interface Args {
  apply: boolean;
  ttlMinutes: number;
  account?: string;
  project?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, ttlMinutes: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--ttl-minutes') args.ttlMinutes = Number(argv[++i]) || 15;
    else if (a === '--account') args.account = argv[++i];
    else if (a === '--project') args.project = argv[++i];
  }
  return args;
}

interface AffectedRow {
  computeId: string;
  accountId: string;
  sessionId: string | null;
  sandboxId: string;
  state: string;
  costUsd: number;
  overSeconds: number;
}

/**
 * Compute the affected set straight from the DB. `last_meaningful` is the last
 * real LLM call for the session (usage_events, indexed) or the session's start;
 * `billed_through` is when billing last advanced. Affected = billed_through is
 * more than `grace` past last_meaningful.
 */
async function loadAffected(args: Args): Promise<AffectedRow[]> {
  const graceSql = sql.raw(`interval '${Math.max(0, Math.floor(args.ttlMinutes))} minutes'`);
  const accountFilter = args.account ? sql`AND cs.account_id = ${args.account}::uuid` : sql``;
  const projectFilter = args.project
    ? sql`AND ss.project_id = ${args.project}::uuid`
    : sql``;

  const rows: any = await db.execute(sql`
    WITH usage AS (
      SELECT session_id, max(created_at) AS last_usage
      FROM kortix.usage_events
      GROUP BY session_id
    )
    SELECT
      cs.id            AS compute_id,
      cs.account_id    AS account_id,
      cs.session_id    AS session_id,
      cs.sandbox_id    AS sandbox_id,
      cs.state         AS state,
      cs.cost_usd      AS cost_usd,
      EXTRACT(EPOCH FROM (
        coalesce(cs.ended_at, cs.last_billed_at)
        - (GREATEST(coalesce(u.last_usage, cs.started_at), cs.started_at) + ${graceSql})
      ))::bigint AS over_seconds
    FROM kortix.sandbox_compute_sessions cs
    LEFT JOIN kortix.session_sandboxes ss ON ss.sandbox_id = cs.sandbox_id
    LEFT JOIN usage u ON u.session_id = cs.session_id
    WHERE cs.cost_usd > 0
      ${accountFilter}
      ${projectFilter}
  `);

  const list: AffectedRow[] = [];
  for (const r of (rows.rows ?? rows) as any[]) {
    const overSeconds = Number(r.over_seconds ?? 0);
    if (overSeconds <= 0) continue; // billed within the grace window → not leaked
    list.push({
      computeId: String(r.compute_id),
      accountId: String(r.account_id),
      sessionId: r.session_id ? String(r.session_id) : null,
      sandboxId: String(r.sandbox_id),
      state: String(r.state),
      costUsd: Number(r.cost_usd),
      overSeconds,
    });
  }
  return list;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function alreadyRefunded(accountId: string, key: string): Promise<boolean> {
  const res: any = await db.execute(sql`
    SELECT 1 FROM kortix.credit_ledger
    WHERE account_id = ${accountId}::uuid AND stripe_event_id = ${key}
    LIMIT 1
  `);
  return (res.rows ?? res).length > 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[reimburse] mode=${args.apply ? 'APPLY' : 'dry-run'} grace=${args.ttlMinutes}m` +
    `${args.account ? ` account=${args.account}` : ''}${args.project ? ` project=${args.project}` : ''}`);

  const affected = await loadAffected(args);

  // Aggregate per account.
  const byAccount = new Map<string, { count: number; refund: number; activeIds: string[] }>();
  for (const r of affected) {
    const agg = byAccount.get(r.accountId) ?? { count: 0, refund: 0, activeIds: [] };
    agg.count += 1;
    agg.refund += r.costUsd;
    if (r.state === 'active') agg.activeIds.push(r.sandboxId);
    byAccount.set(r.accountId, agg);
  }

  const accounts = [...byAccount.entries()].sort((a, b) => b[1].refund - a[1].refund);
  const totalRefund = accounts.reduce((s, [, v]) => s + v.refund, 0);
  const totalSessions = affected.length;

  console.log(`\n[reimburse] affected sessions: ${totalSessions} across ${accounts.length} accounts`);
  console.log(`[reimburse] total refund: $${round2(totalRefund)}\n`);
  console.log('account                                 sessions   refund_usd   active_now');
  for (const [acct, v] of accounts) {
    console.log(`${acct}  ${String(v.count).padStart(8)}   ${String(round2(v.refund)).padStart(10)}   ${String(v.activeIds.length).padStart(9)}`);
  }

  if (!args.apply) {
    console.log('\n[reimburse] DRY-RUN — no changes made. Re-run with --apply to close affected active rows + issue refunds.');
    return;
  }

  console.log('\n[reimburse] APPLY: closing affected active compute rows, then issuing idempotent refunds…');
  let closed = 0;
  let refundedAccounts = 0;
  let refundedUsd = 0;
  let skippedAccounts = 0;

  for (const [acct, v] of accounts) {
    // 1) Stop further billing on affected rows that are still active.
    for (const sandboxId of v.activeIds) {
      try {
        await pauseComputeSession(sandboxId);
        closed += 1;
      } catch (err) {
        console.warn(`[reimburse] pauseComputeSession failed for ${sandboxId}:`, err instanceof Error ? err.message : err);
      }
    }

    // 2) Idempotent full refund for the account.
    const key = `compute_refund:v1:${acct}`;
    if (await alreadyRefunded(acct, key)) {
      skippedAccounts += 1;
      console.log(`[reimburse] ${acct} already refunded (key ${key}) — skipping`);
      continue;
    }
    const amount = round2(v.refund);
    if (amount <= 0) continue;
    try {
      await grantCredits(
        acct,
        amount,
        'compute_refund',
        `Compute over-billing reimbursement — full refund of ${v.count} session(s) affected by the sandbox auto-stop bug`,
        false, // non-expiring
        key,   // → credit_ledger.stripe_event_id UNIQUE index = permanent idempotency
      );
      refundedAccounts += 1;
      refundedUsd += amount;
      console.log(`[reimburse] refunded ${acct}: $${amount} (${v.count} sessions)`);
    } catch (err) {
      console.error(`[reimburse] refund FAILED for ${acct}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n[reimburse] DONE. closed=${closed} compute rows | refunded ${refundedAccounts} accounts ($${round2(refundedUsd)}) | skipped ${skippedAccounts} already-refunded`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[reimburse] fatal:', err);
    process.exit(1);
  });

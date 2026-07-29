#!/usr/bin/env bun
/**
 * ONE-OFF REMEDIATION for the sandboxes that are already wedged.
 *
 * The deadline model stops this from RE-forming. It does not clear the backlog:
 * every one of those boxes is currently kept alive by a lease the box itself
 * renews, and enforcement is off. Somebody has to drain them once, deliberately.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DRY RUN IS THE DEFAULT AND CANNOT BE DISABLED BY ACCIDENT.               │
 * │ Stopping requires BOTH  --apply  AND  REMEDIATE_CONFIRM=<expected count> │
 * │ where the count must equal the number of boxes the plan actually selected│
 * │ — so a plan that grew between your dry run and your apply REFUSES to run.│
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY A SCRIPT AND NOT THE REAPER. The reaper is the steady-state mechanism and
 * must stay boring. A 187-box drain wants a human reading a plan, a per-account
 * cap, a pause between stops, and the ability to stop halfway — none of which
 * belong in a sweep that runs every five minutes forever.
 *
 * WHAT A STOP DOES, AND DOES NOT DO. `provider.stop()` + `applyStoppedState`
 * PARKS the box: the runtime identity is preserved, the filesystem persists, the
 * compute meter closes, and the user's next prompt resumes it. It is not a
 * delete and it is not a reprovision. The worst case for a customer is one
 * re-prompt.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   cd apps/api
 *
 *   # 1. Look. Reads only. Safe to run against prod as often as you like.
 *   DATABASE_URL="$(dotenvx get DATABASE_URL -f .env.prod)" \
 *     bun run scripts/remediate-wedged-sandboxes.ts
 *
 *   # 2. Narrow it, and read the plan again.
 *   ... --min-age-hours 48 --max 25 --per-account 5
 *
 *   # 3. Only when the plan is exactly what you want:
 *   ... --apply REMEDIATE_CONFIRM=<the count printed by step 2>
 *
 * ── FLAGS ───────────────────────────────────────────────────────────────────
 *   --apply             actually stop. Requires REMEDIATE_CONFIRM to match.
 *   --min-age-hours N   only boxes running longer than N hours   (default 12)
 *   --max N             hard cap on boxes stopped this run       (default 25)
 *   --per-account N     cap per account, round-robined           (default 5)
 *   --account <uuid>    restrict to one account
 *   --require-no-usage  only boxes that have NEVER billed an LLM call
 *   --pause-ms N        delay between stops                      (default 2000)
 *   --json              emit the plan as JSON instead of a table
 *
 * ── THE SELECTION RULE, AND WHY IT IS DELIBERATELY NOT `deadline_at` ────────
 * This script predates enforcement, so it must not depend on the backfill
 * having produced sensible deadlines — it is one of the things that would be
 * used if the backfill went wrong. It selects on EVIDENCE the deadline model
 * did not compute: age, and the absence of any billed LLM call or ACP relay.
 * A box with either signal inside the progress grant is NEVER a candidate, at
 * any age, and that exclusion is not overridable by a flag.
 */

import { sql } from 'drizzle-orm';
import { type ProviderName, getProvider } from '../src/platform/providers';
import { applyStoppedState } from '../src/projects/reaping/sandbox-state-sync';
import { db } from '../src/shared/db';

const PROGRESS_GRANT_MS = 2 * 60 * 60 * 1000;

interface Options {
  apply: boolean;
  minAgeHours: number;
  max: number;
  perAccount: number;
  accountId: string | null;
  requireNoUsage: boolean;
  pauseMs: number;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? (argv[index + 1] ?? null) : null;
  };
  const number = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${flag} must be a non-negative number, got ${raw}`);
    }
    return parsed;
  };
  return {
    apply: argv.includes('--apply'),
    minAgeHours: number('--min-age-hours', 12),
    max: number('--max', 25),
    perAccount: number('--per-account', 5),
    accountId: value('--account'),
    requireNoUsage: argv.includes('--require-no-usage'),
    pauseMs: number('--pause-ms', 2000),
    json: argv.includes('--json'),
  };
}

interface PlanRow {
  sandboxId: string;
  sessionId: string;
  accountRef: string;
  provider: string;
  externalId: string;
  status: string;
  ageHours: number;
  source: string;
  lastUsageAgeHours: number | null;
  lastRelayAgeHours: number | null;
}

/**
 * THE PLAN QUERY. Read-only, and the ONLY query this script runs before it has
 * a confirmed apply.
 *
 * Note what is NOT here: no provider call. Building the plan must not depend on
 * the provider answering, both because it would be slow across 187 boxes and
 * because Daytona has a documented 429 history. The provider is consulted once
 * per box at stop time, where a failure is per-box and recoverable.
 */
async function buildPlan(options: Options): Promise<PlanRow[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    WITH live AS (
      SELECT s.sandbox_id, s.session_id, s.account_id, s.provider, s.external_id,
             s.status, s.metadata, s.created_at,
             EXTRACT(EPOCH FROM (now() - s.created_at)) / 3600 AS age_hours,
             (SELECT EXTRACT(EPOCH FROM (now() - max(u.created_at))) * 1000
                FROM kortix.usage_events u
               WHERE u.session_id = s.session_id
                 AND u.account_id = s.account_id
                 AND u.created_at > now() - interval '30 days') AS last_usage_age_ms,
             (SELECT EXTRACT(EPOCH FROM (now() - max(e.created_at))) * 1000
                FROM kortix.acp_session_envelopes e
               WHERE e.session_id = s.session_id
                 AND e.created_at > now() - interval '30 days') AS last_relay_age_ms
        FROM kortix.session_sandboxes s
       WHERE s.status IN ('active', 'provisioning')
         AND s.external_id IS NOT NULL
    ),
    eligible AS (
      SELECT live.*,
             ROW_NUMBER() OVER (PARTITION BY live.account_id ORDER BY live.created_at ASC)
               AS per_account_rank
        FROM live
       WHERE live.age_hours >= ${options.minAgeHours}
         -- THE SAFETY RULE, and it is not overridable by any flag: a box with
         -- billed or relayed progress inside the progress grant is doing work,
         -- whatever its age. NULL means "never" and passes; that is the whole
         -- population this remediation is for.
         AND (live.last_usage_age_ms IS NULL OR live.last_usage_age_ms >= ${PROGRESS_GRANT_MS})
         AND (live.last_relay_age_ms IS NULL OR live.last_relay_age_ms >= ${PROGRESS_GRANT_MS})
         AND (${options.requireNoUsage} = false OR live.last_usage_age_ms IS NULL)
         AND (${options.accountId}::uuid IS NULL OR live.account_id = ${options.accountId}::uuid)
    )
    SELECT * FROM eligible
     WHERE per_account_rank <= ${options.perAccount}
     ORDER BY age_hours DESC
     LIMIT ${options.max}
  `);
  return [...rows].map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const usage = row.last_usage_age_ms === null ? null : Number(row.last_usage_age_ms);
    const relay = row.last_relay_age_ms === null ? null : Number(row.last_relay_age_ms);
    return {
      sandboxId: String(row.sandbox_id),
      sessionId: String(row.session_id),
      // NEVER print a raw account uuid: this output gets pasted into issues and
      // Slack, and this is a public repo. A stable short ref is enough to see
      // the concentration (one account holds 117 of 187 boxes) without
      // identifying the customer.
      accountRef: `acct-${String(row.account_id).slice(0, 8)}`,
      provider: String(row.provider),
      externalId: String(row.external_id),
      status: String(row.status),
      ageHours: Math.round(Number(row.age_hours) * 10) / 10,
      source: typeof metadata.source === 'string' ? metadata.source : 'unknown',
      lastUsageAgeHours: usage === null ? null : Math.round((usage / 3_600_000) * 10) / 10,
      lastRelayAgeHours: relay === null ? null : Math.round((relay / 3_600_000) * 10) / 10,
    };
  });
}

function printPlan(plan: PlanRow[], options: Options): void {
  if (options.json) {
    console.log(JSON.stringify({ mode: options.apply ? 'APPLY' : 'DRY RUN', plan }, null, 2));
    return;
  }
  console.log(`\n${options.apply ? '### APPLY ###' : '### DRY RUN — nothing will be stopped ###'}`);
  console.log(
    `filters: min-age=${options.minAgeHours}h max=${options.max} per-account=${options.perAccount}` +
      `${options.requireNoUsage ? ' require-no-usage' : ''}` +
      `${options.accountId ? ' account=<restricted>' : ''}\n`,
  );
  if (plan.length === 0) {
    console.log('No boxes match. Nothing to do.\n');
    return;
  }
  console.log(
    ['account', 'provider', 'age_h', 'source', 'usage_age_h', 'relay_age_h', 'external_id'].join(
      '\t',
    ),
  );
  for (const row of plan) {
    console.log(
      [
        row.accountRef,
        row.provider,
        row.ageHours,
        row.source,
        row.lastUsageAgeHours ?? 'never',
        row.lastRelayAgeHours ?? 'never',
        row.externalId,
      ].join('\t'),
    );
  }
  const byAccount = new Map<string, number>();
  for (const row of plan) byAccount.set(row.accountRef, (byAccount.get(row.accountRef) ?? 0) + 1);
  console.log(`\n${plan.length} box(es) selected across ${byAccount.size} account(s).`);
  console.log(`oldest ${Math.max(...plan.map((r) => r.ageHours))}h`);
  console.log(
    `never billed an LLM call: ${plan.filter((r) => r.lastUsageAgeHours === null).length}`,
  );
  if (!options.apply) {
    console.log(`\nTo stop exactly these:\n  REMEDIATE_CONFIRM=${plan.length} ... --apply\n`);
  }
}

/**
 * Stop one box, in the same order every production stop path uses: close the
 * meter while the row still says `active`, THEN flip the row. `applyStoppedState`
 * is the single writer that guarantees that ordering and does the jsonb merge,
 * so this script cannot drift from the reaper's semantics.
 *
 * `quiesce: true` is what stops passive traffic resurrecting the box the moment
 * it is parked — without it, a polling tab undoes the whole drain.
 */
async function stopOne(row: PlanRow): Promise<'stopped' | 'already-gone' | 'failed'> {
  const provider = getProvider(row.provider as ProviderName);
  try {
    await provider.stop(row.externalId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A box the provider says is already gone is a SUCCESS for our purposes —
    // the row just needs reconciling, which the same call below does.
    if (!/not\s*found|already|does not exist|404/i.test(message)) {
      console.warn(`  ! stop failed for ${row.externalId}: ${message}`);
      return 'failed';
    }
    await applyStoppedState({
      sandboxId: row.sandboxId,
      sessionId: row.sessionId,
      externalId: row.externalId,
      quiesce: true,
      metadata: { remediatedAt: new Date().toISOString(), remediationReason: 'wedged-backlog' },
    });
    return 'already-gone';
  }
  await applyStoppedState({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    externalId: row.externalId,
    quiesce: true,
    metadata: { remediatedAt: new Date().toISOString(), remediationReason: 'wedged-backlog' },
  });
  return 'stopped';
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const plan = await buildPlan(options);
  printPlan(plan, options);

  if (!options.apply) return;

  // THE INTERLOCK. `--apply` alone is not enough: the confirmation must equal
  // the number of boxes the plan ACTUALLY selected, right now. So a plan that
  // grew between the dry run you read and the apply you typed refuses to run,
  // which is the failure mode a "type yes to continue" prompt does not catch.
  const confirm = process.env.REMEDIATE_CONFIRM;
  if (confirm !== String(plan.length)) {
    console.error(
      `\nREFUSING TO APPLY. REMEDIATE_CONFIRM=${confirm ?? '<unset>'} but the plan selected ${plan.length}. Re-read the plan above and set REMEDIATE_CONFIRM=${plan.length} if it is still what you want.\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (plan.length === 0) return;

  console.log(`\nStopping ${plan.length} box(es), ${options.pauseMs}ms apart…\n`);
  const tally = { stopped: 0, alreadyGone: 0, failed: 0 };
  for (const [index, row] of plan.entries()) {
    const outcome = await stopOne(row);
    if (outcome === 'stopped') tally.stopped += 1;
    else if (outcome === 'already-gone') tally.alreadyGone += 1;
    else tally.failed += 1;
    console.log(`  [${index + 1}/${plan.length}] ${row.externalId} → ${outcome}`);
    // Paced on purpose. Unpaced provider calls are what produced the snapshot
    // rebuild storm and Daytona 429s (PR #5193); a drain is exactly the shape
    // that reproduces it.
    if (index < plan.length - 1 && options.pauseMs > 0) await Bun.sleep(options.pauseMs);
  }
  console.log(
    `\ndone: stopped=${tally.stopped} already-gone=${tally.alreadyGone} failed=${tally.failed}`,
  );
  console.log(
    'Expect a BILLING INVARIANT VIOLATED spike on the next maintenance tick — it is the ' +
      'meter catching up with a bulk stop, not the fix failing.\n',
  );
  if (tally.failed > 0) process.exitCode = 1;
}

// Exported for the dry-run test; `main` runs only when invoked directly.
export { buildPlan, parseArgs, type Options, type PlanRow };

if (import.meta.main) {
  await main();
  process.exit(process.exitCode ?? 0);
}

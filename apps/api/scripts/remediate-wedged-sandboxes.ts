#!/usr/bin/env bun
/**
 * One-shot remediation for the wedged-sandbox backlog.
 *
 * DRY RUN BY DEFAULT. It prints what it WOULD do and exits. Nothing is stopped
 * and no row is touched unless you pass --apply, and --apply additionally
 * requires an explicit --limit so a slip of the finger cannot sweep the fleet.
 *
 * ─── YOU SHOULD PROBABLY NOT RUN THIS ───
 * The deadline migration already fixes the backlog on its own: every live row
 * is backfilled to `now() + 30 minutes`, so half an hour after deploy the
 * reaper stops every box that has not taken a real, control-plane-observed
 * turn. This script exists for the case where you need the boxes gone SOONER
 * than that (a cost incident), or where the reaper itself is wedged and you
 * need a manual hand on the lever. Prefer the deploy. Measure first.
 *
 * WHAT IT CONSIDERS WEDGED
 *   - our row says `active` and the provider agrees the box is running, AND
 *   - the box has never emitted an LLM usage_event (or not for `--idle-hours`).
 * That is the population measured live on 2026-07-29: 187 running boxes, 156
 * with zero usage_events, oldest 264 hours.
 *
 * Every stop goes through applyStoppedState — the single stop writer — so the
 * compute window is settled against the still-active row BEFORE either status
 * flips, exactly like the reaper's own path. This script deliberately contains
 * no bespoke billing logic.
 *
 *   bun apps/api/scripts/remediate-wedged-sandboxes.ts                      # dry run
 *   bun apps/api/scripts/remediate-wedged-sandboxes.ts --idle-hours 24      # dry run, narrower
 *   bun apps/api/scripts/remediate-wedged-sandboxes.ts --apply --limit 25   # actually stop 25
 */

import { sql } from 'drizzle-orm';
import { type ProviderName, getProvider } from '../src/platform/providers';
import { applyStoppedState } from '../src/projects/reaping/sandbox-state-sync';
import { db } from '../src/shared/db';

interface Row {
  sandbox_id: string;
  session_id: string;
  external_id: string;
  provider: ProviderName;
  age_hours: number;
  last_usage_at: string | null;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const APPLY = process.argv.includes('--apply');
const IDLE_HOURS = Number(flag('idle-hours') ?? 6);
const LIMIT = Number(flag('limit') ?? 0);

async function main() {
  if (APPLY && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
    console.error('--apply requires an explicit positive --limit. Refusing to sweep the fleet.');
    process.exit(2);
  }

  const result = await db.execute(sql`
    SELECT s.sandbox_id, s.session_id, s.external_id, s.provider,
           round(extract(epoch from (now() - s.created_at)) / 3600)::int AS age_hours,
           (SELECT max(u.created_at)::text FROM kortix.usage_events u
             WHERE u.session_id = s.session_id) AS last_usage_at
      FROM kortix.session_sandboxes s
     WHERE s.status = 'active'
       AND s.external_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM kortix.usage_events u
              WHERE u.session_id = s.session_id
                AND u.created_at > now() - make_interval(hours => ${IDLE_HOURS}))
     ORDER BY s.created_at ASC`);
  const candidates = (((result as { rows?: Row[] }).rows ?? result) as Row[]) ?? [];

  console.log(
    `${APPLY ? 'APPLY' : 'DRY RUN'} — ${candidates.length} active row(s) with no LLM usage in the last ${IDLE_HOURS}h`,
  );
  // Ids are deliberately truncated: this output gets pasted into issues.
  for (const r of candidates.slice(0, 20)) {
    console.log(
      `  ${r.sandbox_id.slice(0, 8)}…  age=${r.age_hours}h  last_usage=${r.last_usage_at ?? 'NEVER'}  provider=${r.provider}`,
    );
  }
  if (candidates.length > 20) console.log(`  … and ${candidates.length - 20} more`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply --limit <n> to stop them.');
    console.log(
      'Before you do: the deadline backfill clears this backlog 30 minutes after deploy.',
    );
    return;
  }

  let stopped = 0;
  let skipped = 0;
  let errors = 0;
  for (const row of candidates.slice(0, LIMIT)) {
    try {
      // Ask the PROVIDER, never the box. A row we think is active but the
      // provider says is gone needs reconciling, not stopping.
      const status = await getProvider(row.provider).getStatus(row.external_id);
      if (status !== 'running') {
        skipped += 1;
        continue;
      }
      await getProvider(row.provider).stop(row.external_id);
      await applyStoppedState({
        sandboxId: row.sandbox_id,
        sessionId: row.session_id,
        externalId: row.external_id,
        stopReason: 'wedged_backlog_remediation',
      });
      stopped += 1;
    } catch (err) {
      errors += 1;
      console.error(
        `  FAILED ${row.sandbox_id.slice(0, 8)}…:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  console.log(`\nstopped=${stopped} skipped=${skipped} errors=${errors}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

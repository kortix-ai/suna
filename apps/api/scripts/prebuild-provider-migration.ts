#!/usr/bin/env bun
/**
 * Operational prebuild for a planned provider migration (e.g. Daytona → Platinum).
 * Selects a cohort by a configurable fan-out policy and drives each project's
 * target ppwarm image to READY at bounded concurrency — WITHOUT shifting any
 * traffic. Traffic only moves when an on-demand switch adopts a ready row.
 *
 * Concurrency bounds ACTUAL builds, not just DB inserts: each project's prebuild
 * row is inserted with autoDrive:false and driven by a fixed worker pool, so
 * `--concurrency=N` is the true build ceiling. The run AWAITS every drive before
 * exiting (no abandoned detached builds).
 *
 * LONG-RUNNING: a single Platinum build legitimately takes 30-40 min, so a large
 * cohort at low concurrency is a MULTI-HOUR job. Run it under tmux / nohup so an
 * SSH drop doesn't kill it:
 *   tmux new -s prebuild 'bun apps/api/scripts/prebuild-provider-migration.ts …'
 *   nohup bun apps/api/scripts/prebuild-provider-migration.ts … &> prebuild.log &
 * It is IDEMPOTENTLY RESUMABLE: rerun skips already-ready projects and adopts
 * in-flight rows (content-addressed dedup), so an interrupted run is safe to rerun.
 * SIGINT (Ctrl-C) stops launching NEW drives and lets in-flight ones finish; the
 * resume worker + lease fence recover anything still mid-build. Exit code: 0 all
 * good, 1 some drive failed, 130 interrupted (rerun in every non-zero case).
 *
 * Usage:
 *   bun apps/api/scripts/prebuild-provider-migration.ts \
 *     --provider=platinum --policy=recently-active --since-days=7 \
 *     --limit=200 --concurrency=3 [--dry-run=true]
 *   bun apps/api/scripts/prebuild-provider-migration.ts \
 *     --policy=selected --projects=<id1>,<id2>
 *
 * Env equivalents: PREBUILD_PROVIDER, PREBUILD_POLICY, PREBUILD_SINCE_DAYS,
 *   PREBUILD_LIMIT, PREBUILD_CONCURRENCY, PREBUILD_PROJECT_IDS, PREBUILD_DRY_RUN.
 *
 * Policies: recently-active (sessions touched within the window), opted-in
 *   (metadata.prebuild_platinum=true), all-active, selected (explicit ids).
 */
import { db } from '../src/shared/db';
import {
  parsePrebuildConfig,
  prebuildExitCode,
  runPrebuildMigration,
} from '../src/projects/provider-transition/provider-transition-prebuild';

async function main(): Promise<void> {
  const cfg = parsePrebuildConfig(process.env, process.argv.slice(2));
  console.log('[prebuild] config', cfg);

  // SIGINT/SIGTERM: abort NEW launches, let in-flight drives drain. A second
  // signal force-quits (a legit build can be 40 min — one Ctrl-C should not
  // orphan it; hold it or Ctrl-C twice to bail hard).
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = (name: string) => () => {
    if (interrupted) {
      console.error(`[prebuild] second ${name} — force-quitting; in-flight builds continue and are recovered on rerun`);
      process.exit(130);
    }
    interrupted = true;
    console.error(`[prebuild] ${name} — no new drives will start; letting in-flight builds finish (signal again to force-quit)`);
    controller.abort();
  };
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));

  const result = await runPrebuildMigration(db, cfg, { signal: controller.signal });
  console.log('[prebuild] result', result);
  // No eager process.exit(0): runPrebuildMigration already drained every drive.
  process.exit(prebuildExitCode(result));
}

main().catch((err) => {
  console.error('[prebuild] failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});

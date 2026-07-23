#!/usr/bin/env bun
/**
 * Operational prebuild for a planned provider migration (e.g. Daytona → Platinum).
 * Selects a cohort by a configurable fan-out policy and builds each project's
 * target ppwarm image in the background at bounded concurrency — WITHOUT shifting
 * any traffic. Traffic only moves when an on-demand switch adopts a ready row.
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
  runPrebuildMigration,
} from '../src/projects/provider-transition/provider-transition-prebuild';

async function main(): Promise<void> {
  const cfg = parsePrebuildConfig(process.env, process.argv.slice(2));
  console.log('[prebuild] config', cfg);
  const result = await runPrebuildMigration(db, cfg);
  console.log('[prebuild] result', result);
  process.exit(0);
}

main().catch((err) => {
  console.error('[prebuild] failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});

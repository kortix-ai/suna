#!/usr/bin/env bun
/**
 * Operator commands for the workspace split (workspaces/split/split-runner.ts).
 * The leader-only worker job runs the same functions on its own; use this for
 * one account, one run, or a reverse.
 *
 *   cd apps/api && dotenvx run -q -- bun scripts/workspace-split.ts <command>
 *
 *   status                               phase counts of kortix.workspace_split_runs and the
 *                                        owner email outbox (kortix.workspace_split_emails)
 *   plan [--account <account_id>]        the dry-run plan pass (moves nothing)
 *   report                               dry-run aggregates of the runs still to apply (counts and credits only)
 *   apply <run_id>                       apply one planned run now
 *   repair <run_id>                      the repair pass of one done run now (normally the tick, 120 s after the move)
 *   reverse <run_id>                     undo one done run
 *   reopen <run_id>                      plan a reversed run again (the next apply splits it into a fresh account)
 *   confirm-keeper <account_id> <project_id>
 *                                        an owner's keeper choice; releases a held account
 *   fill <account_id>... | fill --null [--limit <n>]
 *                                        stamp workspace_id on an account's expand rows
 *                                        (kortix.workspace_fill_account). --null finds the
 *                                        accounts with a live workspace id whose rows are
 *                                        still NULL (an account that left split_pending
 *                                        outside the split runner, e.g. by a transfer);
 *                                        the Release 2 gate (design.md §8, R2a) runs it
 *
 * The worker's mode is WORKSPACE_SPLIT_MODE, or at runtime:
 *   INSERT INTO kortix.platform_settings (key, value) VALUES ('workspace_split', '{"mode":"apply"}')
 *   ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/shared/db';
import {
  applyWorkspaceSplitRun,
  confirmWorkspaceSplitKeeper,
  planWorkspaceSplits,
  reopenWorkspaceSplitRun,
  repairWorkspaceSplitRun,
  reverseWorkspaceSplitRun,
  workspaceSplitReport,
} from '../src/workspaces/split/split-runner';

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (command) {
    case 'status': {
      const rows = await db.execute<{ phase: string; mode: string; n: number }>(sql`
        SELECT phase, mode, count(*)::int AS n FROM kortix.workspace_split_runs GROUP BY 1, 2 ORDER BY 1, 2`);
      // The owner email outbox (owner-email.ts): counts per state, no address.
      const emails = await db.execute<{ state: string; n: number; max_attempts: number }>(sql`
        SELECT state, count(*)::int AS n, max(attempts)::int AS max_attempts FROM kortix.workspace_split_emails GROUP BY 1 ORDER BY 1`);
      console.log(JSON.stringify({ runs: rows, owner_emails: emails }, null, 2));
      return 0;
    }
    case 'plan': {
      const account = args[0] === '--account' ? args[1] : undefined;
      console.log(JSON.stringify(await planWorkspaceSplits(account ? { accountIds: [account] } : {}), null, 2));
      return 0;
    }
    case 'report':
      console.log(JSON.stringify(await workspaceSplitReport(), null, 2));
      return 0;
    case 'apply':
      if (!args[0]) break;
      console.log(await applyWorkspaceSplitRun(args[0]));
      return 0;
    case 'repair': {
      if (!args[0]) break;
      const repaired = await repairWorkspaceSplitRun(args[0]);
      console.log(JSON.stringify(repaired ?? { error: 'not a done run' }, null, 2));
      return repaired ? 0 : 1;
    }
    case 'reverse':
      if (!args[0]) break;
      await reverseWorkspaceSplitRun(args[0]);
      console.log('reversed');
      return 0;
    case 'reopen':
      if (!args[0]) break;
      await reopenWorkspaceSplitRun(args[0]);
      console.log('reopened');
      return 0;
    case 'fill': {
      const accounts = args[0] === '--null'
        ? await accountsWithNullWorkspaceIds(Number(args[args.indexOf('--limit') + 1]) || 500)
        : args;
      if (!accounts.length && args[0] !== '--null') break;
      let rows = 0;
      for (const accountId of accounts) {
        const [row] = await db.execute<{ n: number }>(sql`SELECT kortix.workspace_fill_account(${accountId}::uuid) AS n`);
        rows += Number(row?.n ?? 0);
      }
      console.log(JSON.stringify({ accounts: accounts.length, rows }, null, 2));
      return 0;
    }
    case 'confirm-keeper':
      if (!args[0] || !args[1]) break;
      await confirmWorkspaceSplitKeeper(args[0], args[1]);
      console.log('confirmed');
      return 0;
  }
  console.error('usage: workspace-split.ts status | plan [--account <id>] | report | apply <run_id> | repair <run_id> | reverse <run_id> | reopen <run_id> | confirm-keeper <account_id> <project_id> | fill <account_id>... | fill --null [--limit <n>]');
  return 2;
}

/**
 * Accounts that have a live workspace id but expand rows still NULL, up to
 * `limit`: a sample of each expand table's NULL rows (one indexed probe per
 * table is not available in Release 1, so each table is read in a bounded
 * scan), kept when kortix.workspace_id_of_account answers.
 */
async function accountsWithNullWorkspaceIds(limit: number): Promise<string[]> {
  const [tables] = await db.execute<{ names: string[] }>(sql`SELECT kortix.workspace_expand_tables() AS names`);
  const found = new Set<string>();
  for (const table of tables?.names ?? []) {
    if (found.size >= limit) break;
    const rows = await db.execute<{ account_id: string }>(sql`
      SELECT DISTINCT t.account_id::text FROM (
        SELECT account_id FROM kortix.${sql.raw(table)} WHERE workspace_id IS NULL AND account_id IS NOT NULL LIMIT ${limit * 20}
      ) t WHERE kortix.workspace_id_of_account(t.account_id) IS NOT NULL LIMIT ${limit - found.size}`);
    for (const row of rows) found.add(row.account_id);
  }
  return [...found];
}

process.exit(await main());

#!/usr/bin/env bun
/**
 * Operator commands for the workspace split (workspaces/split/split-runner.ts).
 * The leader-only worker job runs the same functions on its own; use this for
 * one account, one run, or a reverse.
 *
 *   cd apps/api && dotenvx run -q -- bun scripts/workspace-split.ts <command>
 *
 *   status                               phase counts of kortix.workspace_split_runs
 *   plan [--account <account_id>]        the dry-run plan pass (moves nothing)
 *   apply <run_id>                       apply one planned run now
 *   reverse <run_id>                     undo one done run
 *   reopen <run_id>                      plan a reversed run again (the next apply splits it into a fresh account)
 *   confirm-keeper <account_id> <project_id>
 *                                        an owner's keeper choice; releases a held account
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
  reverseWorkspaceSplitRun,
} from '../src/workspaces/split/split-runner';

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (command) {
    case 'status': {
      const rows = await db.execute<{ phase: string; mode: string; n: number }>(sql`
        SELECT phase, mode, count(*)::int AS n FROM kortix.workspace_split_runs GROUP BY 1, 2 ORDER BY 1, 2`);
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    case 'plan': {
      const account = args[0] === '--account' ? args[1] : undefined;
      console.log(JSON.stringify(await planWorkspaceSplits(account ? { accountIds: [account] } : {}), null, 2));
      return 0;
    }
    case 'apply':
      if (!args[0]) break;
      console.log(await applyWorkspaceSplitRun(args[0]));
      return 0;
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
    case 'confirm-keeper':
      if (!args[0] || !args[1]) break;
      await confirmWorkspaceSplitKeeper(args[0], args[1]);
      console.log('confirmed');
      return 0;
  }
  console.error('usage: workspace-split.ts status | plan [--account <id>] | apply <run_id> | reverse <run_id> | reopen <run_id> | confirm-keeper <account_id> <project_id>');
  return 2;
}

process.exit(await main());

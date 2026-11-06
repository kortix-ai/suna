#!/usr/bin/env bun
/**
 * Workspace invariants I1–I12 (Workspaces design.md §7), read-only.
 *
 *   cd apps/api && dotenvx run -q -- bun scripts/workspace-invariants.ts [--run <run_id> ...] [--account <account_id> ...]
 *
 * Prints one JSON report: per invariant, `ok`, the violation count and up to
 * 10 internal ids. Exit code 1 when any invariant fails. Reads only: no
 * INSERT, UPDATE, DELETE or DDL. It needs API_KEY_SECRET for I3 (it decrypts
 * nothing it prints; the plaintext is discarded). Share aggregates only.
 *
 *   I1  no account holds 2+ active projects that are not split-pending
 *   I2  a split project's rows carry its account on every moved table
 *   I3  every secret of a split-off account decrypts with its key
 *   I4  every user holding a grant is a member of that account
 *   I5  split-off accounts had no billing at the move; sources kept Stripe
 *   I6  a 1:1 workspace's account name equals its project name
 *   I7  grants per principal on the moved workspace are unchanged
 *   I8  every member a split added holds a grant on the new workspace or is an owner
 *   I9  kortix.workspaces equals kortix.workspaces_expected for every account
 *   I10 every expand-table row has workspace_id = its account's live id (NULL
 *       only on a split_pending account)
 *   I11 no two credit_accounts rows share a stripe_subscription_id
 *   I12 every account has one live row (one per active project while split_pending)
 *
 * I9 and I10 read every account and every expand-table row: on prod they are
 * full scans (credit_ledger ~8.6M rows). Run them off-peak, read-only.
 */
import { checkWorkspaceInvariants } from '../src/workspaces/split/invariants';

const runIds: string[] = [];
const accountIds: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--run' && argv[i + 1]) runIds.push(argv[(i += 1)]!);
  else if (argv[i] === '--account' && argv[i + 1]) accountIds.push(argv[(i += 1)]!);
  else {
    console.error(`unknown argument: ${argv[i]}`);
    process.exit(2);
  }
}

const report = await checkWorkspaceInvariants({
  ...(runIds.length ? { runIds } : {}),
  ...(accountIds.length ? { accountIds } : {}),
});
console.log(JSON.stringify(report, null, 2));
process.exit(Object.values(report).every((r) => r.ok) ? 0 : 1);

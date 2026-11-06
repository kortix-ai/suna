---
title: Workspaces — the legacy split runbook (W1)
status: implemented on branch ws-split (merged into `workspaces`, PR #11857)
updated: 2026-11-05
---

# The workspace split: runbook

The split turns each project of a legacy multi-project account into its own
workspace (design.md §2 row "S", decisions.md D4). It runs in the API runtime
because secrets are sealed per account and the migrate job has no
`API_KEY_SECRET`.

## Code

| Part | File |
|---|---|
| Transfer engine (moves a project; split mode keeps and remaps grants) | `apps/api/src/projects/lib/project-transfer.ts` |
| Split data movement and its reverse (one transaction) | `apps/api/src/projects/lib/workspace-split-copy.ts` |
| Plan, ledger, lease, mode, reverse, keeper confirm | `apps/api/src/workspaces/split/split-runner.ts` |
| Invariants I1–I7 | `apps/api/src/workspaces/split/invariants.ts` |
| Worker job (leader only) | `apps/api/src/worker/jobs/workspace-split.ts` |
| Operator CLI | `apps/api/scripts/workspace-split.ts` |
| Invariant CLI (read-only) | `apps/api/scripts/workspace-invariants.ts` |
| DB suite | `apps/api/src/workspaces/split/workspace-split.integration.test.ts` |

## Mode

1. `WORKSPACE_SPLIT_MODE` = `off` | `dry_run` | `apply` (`dry-run` is accepted).
2. Unset: `dry_run` when `INTERNAL_KORTIX_ENV` is set (dev, staging, prod,
   preview), `off` locally and on self-host.
3. Runtime override without a deploy, in `kortix.platform_settings`:

   ```sql
   INSERT INTO kortix.platform_settings (key, value) VALUES ('workspace_split', '{"mode":"apply"}')
   ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();
   ```

Cadence: `off` re-reads the mode every 1 h. `dry_run` plans every 6 h.
`apply` plans at most every 30 min and moves up to 5 projects per pass, one
pass a minute while a backlog lasts. Heartbeat stale limit: 8 h.

## What one move does (one transaction)

- New account named after the project; the source's MFA, session and PAT
  policies, session oversight, automation pause and branding are copied.
- Copied: every membership, every group with its members, every custom role
  with its permissions, every account-scope grant (users, groups, the
  project's service accounts, pending invitees whose invite is split).
- Remapped, not dropped: the project's group, custom-role and pending grants;
  the project secrets' member grants.
- Account-wide secrets (`project_id IS NULL`) are copied and re-sealed for the
  new account with their grants; the moved sessions' provider pools point at
  the copies. An undecryptable source secret is left behind and listed in
  `copied_ids.undecryptableSecrets`.
- GitHub installations, GitHub user tokens and legacy Claude logins are
  copied (tokens and logins re-sealed).
- Pending invites: the moved project's `bootstrap_grants` entries leave the
  source invite and form a new invite in the new account. The invitee's old
  email link still opens the source invite, which no longer carries the moved
  project.
- App hosting rows follow by `app_id`; site blobs are copied to the new
  account's prefix before the transaction (phase `storage_copied`).
- Stays with the keeper: wallet, Stripe, contracts, OAuth clients and tokens,
  API keys, account tokens with no project, Capture, tunnels, ledgers, audit.
- The new account starts on Free with 0 credits (`initializeFreeTierAccount`
  with `freeCredits: false`, after commit).
- When the source is left with one project, its account takes the keeper's
  name (old name in `workspace_name_backups`).

## Keeper and holds

- Keeper = the most recently opened active project, then the newest created.
- Frozen once a move of the account started (`storage_copied`/`done`) or an
  owner confirmed it.
- An account with a completed purchase, a Stripe subscription or an
  enterprise contract is `held` until its owner chooses:
  `bun scripts/workspace-split.ts confirm-keeper <account_id> <project_id>`.

## Ledger phases (`kortix.workspace_split_runs.phase`)

`planned` → `storage_copied` → `done`; also `held`, `failed` (5 attempts),
`skipped`, `reversed`. A crash inside the move commits nothing; a run whose
heartbeat is older than 10 min is reclaimed, and `attempts` fences a lost lease.

## Operate

```bash
cd apps/api
dotenvx run -q -- bun scripts/workspace-split.ts status
dotenvx run -q -- bun scripts/workspace-split.ts plan
dotenvx run -q -- bun scripts/workspace-split.ts apply <run_id>
dotenvx run -q -- bun scripts/workspace-invariants.ts            # exit 1 on any violation
dotenvx run -q -- bun scripts/workspace-split.ts reverse <run_id>
dotenvx run -q -- bun scripts/workspace-split.ts reopen <run_id>   # plan a reversed run again
```

Reverse is refused when the new account took money or holds another project.
It deletes exactly the copies in `copied_ids`; the account row stays as a
dormant record with no members. A source that holds 2+ projects again gets
back the name the split replaced (from `workspace_name_backups`). A reversed
project is not planned again while its `reversed` row exists: `reopen
<run_id>` turns it back into `planned` with no target, and the next apply
splits it into a fresh account (the dormant one is listed in
`plan.reversed_to_account_ids`).

## Before `apply` in prod

1. Run `dry_run` and review aggregates only: `plan->'account'` counts of
   `unbound_tokens_staying`, `api_keys_staying`, `oauth_clients_staying`
   (design.md §7 risk 1: tell those owners first).
2. Rehearse on a restored snapshot (needs Marko's approval, design.md §7 (c)).
3. Switch to `apply`; run the invariant CLI after each batch.

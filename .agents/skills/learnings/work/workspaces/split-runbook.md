---
title: Workspaces — the legacy split runbook (W1)
status: implemented on branch ws-split (merged into `workspaces`, PR #11857); enforced (K4, findings 5, 6, 7, 27, 30, 32) on ws-r1-split
updated: 2026-11-06
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
| Invariants I1–I12 | `apps/api/src/workspaces/split/invariants.ts` |
| Split notice on `GET /v1/workspaces/:id` (C9) | `apps/api/src/workspaces/split/notice.ts` |
| Owner email (C9) | `apps/api/src/workspaces/split/owner-email.ts` |
| Split-off billing (C6, billing stream) | `apps/api/src/billing/services/split-off-billing.ts` |
| Rotated-login write-back (by `secret_id`) | `apps/api/src/llm-gateway/credentials/rotating-login-write.ts` |
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
- The reach rule (`reachingUsersSql`, `reachingGroupsSql` in
  `workspace-split-copy.ts`): a person or group reaches the moved project
  through a grant on it, an owner/admin or custom account role, a reaching
  group, a grant on one of its project secrets, or super admin. An account
  `member` grant alone reaches nothing.
- Copied for the people and groups who reach the project only: their
  memberships, their account-scope grants, the reaching groups with their
  members; every custom role with its permissions; the project's service
  accounts' grants; pending invitees whose invite is split. A member with a
  grant on another project only stays behind.
- Remapped, not dropped: the project's group, custom-role and pending grants;
  the project secrets' member grants.
- Account-wide secrets (`project_id IS NULL`) are copied and re-sealed for the
  new account with the grants of the people who came along; the moved
  sessions' provider pools point at the copies. An undecryptable source secret
  is left behind and listed in `copied_ids.undecryptableSecrets`.
- A rotating login (`codex`/`CODEX_AUTH_JSON`; an OpenCode Console login in
  the OpenCode key secret) is never duplicated. The side that used it last
  (the newest session pool that names it, else the owner's newest session)
  keeps the working login; the other side gets an inactive placeholder
  (`needs_reauth_at = now()`, empty value) that the clients show as
  "Reconnect". When the moved project wins, the copy is live and the source
  row becomes the placeholder. `copied_ids.rotatingLogins` records it; a
  reverse puts the newest value back on the source row. A static API key is
  copied to both.
- The account default model (`scope='account'`) and the account-wide agent
  pins are copied; the project's own default (`scope='project'`,
  `scope_key = project_id`) moves with the project.
- GitHub installations, GitHub user tokens and legacy Claude logins are
  copied (tokens and logins re-sealed; none of them rotates).
- Pending invites: the moved project's `bootstrap_grants` entries leave the
  source invite and form a new invite in the new account. The invitee's old
  email link still opens the source invite, which no longer carries the moved
  project.
- App hosting rows follow by `app_id`; site blobs are copied to the new
  account's prefix before the transaction (phase `storage_copied`).
- Stays with the keeper: wallet, Stripe, contracts, OAuth clients and tokens,
  API keys, account tokens with no project, Capture, tunnels, ledgers, audit.
- The new account's wallet is written in the move's transaction (Free, 0
  credits, not eligible), so no billing repair grants signup credits.
- When the source is left with one project, its account takes the keeper's
  name (old name in `workspace_name_backups`).

## After a move commits

Each step is recorded in the run's `plan`; the leader tick retries a step
that failed.

1. Caches: the project-scoped IAM memos (LISTEN/NOTIFY, every replica) and
   both accounts' default-model caches (process-local, 30 s TTL).
2. `kortix.workspace_fill_account` for the new account.
3. Billing (C6): `applySplitOffBilling` → `plan.billing`. A free source: the
   split-off goes on Free, keeps free-credit eligibility (a one-time
   exception, no `free_credit_claims` row) and gets one Free grant
   (`split_off_grant:<run_id>`). A paying source: the keeper's plan, comped,
   no Stripe subscription, until `min(keeper's period end, now + 31 d)`, with
   pro-rated plan credits (`split_off_comp:<run_id>`). A reopened run uses
   `<run_id>:<new account id>` as its key.
4. When it was the account's last move (no `planned`/`held`/`storage_copied`
   run, one active project left): `workspace_fill_account` for the keeper and
   every split-off, then one outbox row per owner of the source account in
   `kortix.workspace_split_emails` (unique key
   `workspace-split-email:<from_account_id>:<user_id>`; members are never
   mailed). The tick sends the rows in `apply` mode only; in `off` and
   `dry_run` they stay `pending`, also after an operator `apply <run_id>`.
   A claim holds a 5-minute lease; a failure retries after 2, 4, 8, 16 min
   (5 attempts, then `failed` for an operator); a `sending` row with an
   expired lease (a crash mid-send) is claimed again. `skipped` + `last_error`
   says why a row sent nothing (`no_email`, `email_not_configured`,
   `split_not_finished`, `not_an_owner`). `status` prints the counts.
5. Repair pass at `completed_at + 120 s`: the move's own idempotent UPDATEs
   again (`moveOwnedRows`), for a row a request that read the project before
   the move committed with the old account (a session create, a prompt
   enqueue), then I2 for the run → `plan.repaired_at`, `repaired_rows`,
   `repair_i2_violations`.

`GET /v1/workspaces/:id` carries `split_notice` (`role` keeper | moved,
`source_name`, `completed_at`, `billing` free | comped | null,
`comped_until`) for 30 days after the account's last move.

## Keeper and holds

- Keeper = the most active project (Marko, 2026-11-06): the most
  `project_sessions` created in the last 30 days (`KEEPER_ACTIVITY_DAYS`);
  a tie goes to the most recently opened (`last_opened_at DESC NULLS LAST`),
  then the newest created, then `project_id`. Each plan row records
  `recent_sessions` (its project) and `keeper_recent_sessions`.
- Until it is frozen, every plan pass re-ranks the keeper: a project that
  gains sessions can become the keeper before the first move starts.
- Frozen once a move of the account started (`storage_copied`/`done`) or an
  owner confirmed it.
- An account that pays (`kortix.account_is_paying`: a paid plan, bought
  credits, a completed purchase, an active enterprise contract) is `held`
  until its owner chooses:
  `bun scripts/workspace-split.ts confirm-keeper <account_id> <project_id>`.
  A Stripe subscription id on a Free account pays nothing and holds nothing,
  and neither does a split-off comp alone.
- A top-up-only source or an enterprise contract on Free is held the same
  way; after the confirmation its split-offs get Free with free-credit
  eligibility (never a comp), and the purchased credits and the contract stay
  with the keeper (design.md §3.3 "Paying holds, D3").
- The plan pass also clears a `split_pending` flag left on an account's only
  active project (`stale_flags_cleared`); the `projects_split_pending_sync`
  trigger keeps the flag right for every later write.

## Ledger phases (`kortix.workspace_split_runs.phase`)

`planned` → `storage_copied` → `done`; also `held`, `failed` (5 attempts),
`skipped`, `reversed`. A crash inside the move commits nothing; a run whose
heartbeat is older than 10 min is reclaimed, and `attempts` fences a lost lease.

## Operate

```bash
cd apps/api
dotenvx run -q -- bun scripts/workspace-split.ts status
dotenvx run -q -- bun scripts/workspace-split.ts plan
dotenvx run -q -- bun scripts/workspace-split.ts report           # aggregates only
dotenvx run -q -- bun scripts/workspace-split.ts apply <run_id>
dotenvx run -q -- bun scripts/workspace-split.ts repair <run_id>  # the 120 s repair pass, now
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

1. Run `dry_run` and review `report` (aggregates only: accounts, projects to
   move, held accounts, `rotating_logins`, `free_grant_credits_total`,
   `comp_credits_total`, `unbound_tokens_staying`, `api_keys_staying`,
   `oauth_clients_staying`). Tell the owners of accounts with staying
   tokens, keys or OAuth clients first (design.md §3.6).
2. Rehearse on a restored snapshot (needs Marko's approval, design.md §7 (c)).
3. Switch to `apply`; run the invariant CLI after each batch.

## Rehearsal on the 1/20 prod-shape seed

`apps/api/scripts/seed-prod-shape.ts` writes the shape (synthetic, local
only). Rehearse on a throwaway copy, never on the worktree database itself:

1. `CREATE DATABASE <copy> TEMPLATE <kortix_dbsuite_tpl_*>`: the DB-suite
   runner's fresh, fully migrated template of the branch's migration set.
2. Seed it, then replay M2 on the seeded data (delete its ledger row, run
   `pnpm --filter @kortix/db migrate:local`): in a deploy the data exists
   before M2 runs, and I6 fails otherwise.
3. `plan` → `report` → `apply` (every run) → `workspace-invariants`
   (I1–I12 = 0) → `reverse` one run → `reopen` it → `apply` again →
   `workspace-invariants` → `confirm-keeper` on the held account → `apply`.
4. Set `EMAIL_URL=mailpit://127.0.0.1:54324` (local capture only) and empty
   every other provider before a tick in `apply` mode.
5. Drop the copy.

The measured numbers of the last rehearsal are in the PR body of #11857.

---
title: Workspaces — fold hard into one primitive (design, Release 1 spec, Releases 2 and 3)
status: approved (Marko 2026-11-06, "yea go revamp"). Release 1 = PR #11857 (branch `workspaces`), being built. Releases 2 and 3 are specified here and not built.
updated: 2026-11-06
---

# Workspaces: design and release spec

Read order: §0 (the decision), §1 (end state), §2 (the three releases), §3 (Release 1,
the work in flight), §4 and §5 (Releases 2 and 3). §6 holds the measured facts. §7 lists
what stays from the 2026-11-05 design.

Words used here, one meaning each:

| Word | Meaning |
|---|---|
| workspace | The one primitive. One company in Kortix: people, agents, sessions, connectors, files, billing. |
| `workspace_id` | The workspace's public id. |
| legacy account key | `account_id` / `legacy_account_id`: the id of the old `accounts` row. A lookup key only. |
| project row | The old `kortix.projects` row of a workspace: its config repo (`kortix.yaml`, agents, skills). |
| live row | The one `kortix.workspaces` row that IS the workspace of an account (§3.2 C1). |
| tombstone | A `kortix.workspaces` row for an archived project row that is not its account's live row. |
| split_pending | A legacy account with 2+ active project rows that the split has not separated yet. |

---

## 0. Decision: fold hard into workspaces

**D8 (Marko, 2026-11-06).** One primitive, `workspace`. One id, `workspace_id`. Account and
project stop being concepts in the data model. Marko: "Hardcore treat everything 100% like
SLACK Workspace, each being independent & all is per Workspace", "it should all just be
'workspace'", "no all compatibility & backwards comp should stay".

Compatibility lives **at the edge, permanently**:

- `/v1/accounts/**`, `/v1/projects/**`, `/v1/account-invites/**`, `/v1/connectors/projects/**`,
  `/scim/v2/accounts/**` stay mounted with their old answers.
- Every response that names a workspace keeps `account_id` (documented as deprecated) and
  `project_id`, next to `workspace_id`.
- `legacy_account_id → workspace_id` is a permanent lookup, so every old id keeps working
  on the legacy routes.
- SDK `Project*` / `Account*` exports, `kortix projects`, `--project`, `KORTIX_PROJECT_ID`
  and the legacy IAM action names stay.

This **supersedes** two earlier positions:

1. The 2026-11-05 §0 recommendation ("two physical keys, one entity, rename nothing, a
   view"). The view becomes a table in Release 1. The columns are renamed in Release 3.
2. D7's "the old DB names stay". Old names stay at the edge. They leave the database.

The fold is safe because it is three releases (expand → flip → contract). Each release is
gated on read-only prod facts (§2). Data that is infeasible to rewrite is not rewritten:
the ledgers (`audit_events` ~400 GB, `gateway_request_logs` 48 GB) keep their legacy payer
key under a new name (§5 step 4).

---

## 1. End state (after Release 3)

### 1.1 `kortix.workspaces` is the one tenant table

| Column | Type | Note |
|---|---|---|
| `workspace_id` | uuid PK | The public id. Never changes after it is served. |
| `legacy_account_id` | uuid UNIQUE NULL | The old account id. NULL only on a tombstone. The permanent lookup key. |
| `former_account_id` | uuid NULL | Tombstones only: the account the archived project row belonged to. |
| `lifecycle` | text | `active` · `dormant` · `closing` · `tombstone` (§3.2 C1). |
| `name` | varchar(255) | The one name. |
| `has_config_repo` | boolean | False for a workspace that was never set up. |
| config-repo columns | — | `repo_url`, `default_branch`, `manifest_path`, `secret_default_strategy`, `metadata`, `sandbox_provider_generation`, `idempotency_key`, `last_opened_at` (NULL when `has_config_repo` is false). |
| settings columns | — | `setup_complete_at`, `setup_wizard_step`, `mfa_required`, `session_max_lifetime_minutes`, `session_idle_timeout_minutes`, `pat_max_lifetime_days`, `pat_require_expiry`, `pat_idle_revoke_days`, `admins_see_all_sessions`, `automations_paused_at`, `automations_paused_by`, `branding`. |
| `deletion_scheduled_for` | timestamptz NULL | Set while an account deletion request is open. |
| `created_at`, `updated_at` | timestamptz | |

`split_pending` does not exist in the end state: Release 2 starts only after it is false
everywhere.

### 1.2 Every other table

| Class | End state |
|---|---|
| Workspace-owned (sessions, secrets, connectors, apps, triggers, drives, IAM, directory, billing state, Capture, …) | `workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE`. No `account_id`. |
| Ledgers and history (`usage_events`, `gateway_request_logs`, `storage_charges`, `audit_events` and partitions, `audit_activity_daily`, `tunnel_audit_logs`, `tunnel_device_auth_requests`, `claude_subscription_login_flows`, `notifications`, `legacy_sandbox_migrations`, `suna_account_migrations`) | `workspace_id` (NULL for an account-level row) plus `legacy_account_id` (the payer or tenant at the time of the event, renamed from `account_id`, resolved through `workspaces.legacy_account_id`). Never rewritten. |
| Person-keyed (`platform_user_roles`, `feedback`, `chrome_connections`, `free_credit_claims`, `person_deletion_requests`, tunnel private machines) | Keyed by the person. Unchanged. |
| Compatibility views | `kortix.accounts` and `kortix.projects`: read-only views over `workspaces`, kept for ad-hoc SQL and analytics. No code reads or writes them. |
| IAM | `role_assignments.scope_type` is `workspace` (plus object grants). Action strings are the `workspace.*` names. The four system roles are the ladder: owner, admin, manager, member. |

### 1.3 Invariants of the end state

1. One account = one workspace: `legacy_account_id` is unique.
2. Every workspace-owned row has `workspace_id`, and it names a live workspace or a tombstone.
3. No row anywhere holds an `account_id` that differs from its workspace's `legacy_account_id`,
   except ledger rows from before a split (the payer at the time).

---

## 2. The three releases

| Release | What | Gate to start | Downtime |
|---|---|---|---|
| **R1** (this PR, #11857) | Everything user-visible at once: workspace on every surface (API, SDK, CLI, TUI, kortixd, web, desktop, mobile, docs, skills, copy), one Settings panel, workspace-based pricing, one IAM scope and one credential fence, the workspace lifecycle, the legacy split (shipped in `dry_run`). Plus the EXPAND migrations for R2: the `kortix.workspaces` table kept in sync by triggers, `workspace_id` on the account-only tables with dual-write triggers and a batched backfill, shadow reads that log mismatches. | — | none |
| **R2** (two deploys, R2a and R2b) | `kortix.workspaces` becomes the source of truth. Writers move to it. `accounts` and `projects` become read-only compatibility views. Twin foreign keys into `workspaces` are added and validated online. | Prod, read-only aggregates: 0 `split_pending` rows; 0 shadow mismatches for 7 consecutive days; invariants I1–I12 exit 0; 0 NULL `workspace_id` on the expand tables; 0 lint suppressions for direct `accounts`/`projects` imports. Marko approves. | none |
| **R3** (planned cutover) | Rename `project_id → workspace_id` in 132 relations, drop the redundant `account_id`, rename the ledgers' `account_id` to `legacy_account_id`, drop the old foreign keys and the two legacy stores. Catalog-only DDL. | R2b live 7 days; counts equal (every account and project row is in `workspaces`); the cutover rehearsed on a restored snapshot (needs Marko's approval). Marko approves the window. | ~2 min, announced |

Switching the split from `dry_run` to `apply` on prod is a separate step after R1 ships.
Marko approves it. It is the prerequisite for the R2 gate "0 `split_pending` rows".

---

## 3. Release 1 spec

### 3.1 Decided behavior: the four known items and the 40 review findings

Each row is the behavior Release 1 ships. "Stream" names the owner (§3.4). The full
findings, with evidence, are the review's `confirmed.json` (session scratchpad, not in
the repo).

| # | Decided behavior | Stream |
|---|---|---|
| **K1** | One auth model. Delete `WORKSPACE_ADMIN_PROJECT_ACTIONS`, `isWorkspaceAdministration` and `authorize` step 4b. Delete the fence's `admin` flag. A workspace-bound credential reaches every route of its own workspace (C4). The person's grants decide for a person and for an inherited (ungoverned) agent session; `grant ∩ ceiling − HUMAN_ONLY` decides for a governed agent. `HUMAN_ONLY` (C8) is the only agent wall: minting credentials and moving money. `kortix access invite` from the onboarding skill and the kortixd `kortix_people` tool work in a session. | auth |
| **K2** | Workspace lifecycle = account lifecycle. `DELETE /v1/workspaces/:id` (and `DELETE /v1/projects/:id` on a 1:1 workspace) closes the account in the same transaction as the project archive: an `account_deletion_requests` row with the 14-day grace (the existing closure model, D6b), every credential of the account revoked, channels and event subscriptions released, automations stopped. After commit: `cancelSubscription(accountId, 'workspace_deleted')` (cancel at period end). Members lose access at once (engine rule, C3). Owners see the workspace as `deleting` and can restore it until `deletion_scheduled_for` (`POST /v1/workspaces/:id/restore`: cancel the request, un-archive, `reactivateSubscription`). The existing sweep erases it at `scheduled_for` (repo, sandboxes, Stripe, wallet, rows). A `split_pending` workspace keeps the old behavior: archive its project row only. Nothing billable is invisible: a project-less account that pays is listed as `setup_required` (C1, C5). | identity |
| **K3** | `GET /v1/workspaces` lists every workspace the caller may see, across all accounts, in one request (C5). A workspace-bound credential gets its one workspace. `POST /v1/workspaces` creates a workspace with no flag (C5). The old `GET /v1/projects` keeps its single-account meaning. `new_workspace` stays on `POST /v1/projects/provision` only. `/provision`, `/provision-stream`, root `POST /`, `/quota`, `/:id/transfer`, root `/link-repository` and `/create-repo` are not mounted under `/v1/workspaces`. | api |
| **K4** | The paying rule is `kortix.account_is_paying` (C6): paid tier, purchased credits or an active enterprise contract; a bare `stripe_subscription_id` never counts (149 legacy accounts carry a stale one on Free). Split-off billing (C6): a free source's split-off keeps free-credit eligibility and gets one Free grant (a one-time exception, no `free_credit_claims` row); a paying source's split-off gets the keeper's plan comped until the keeper's current period ends, with pro-rated plan credits, then falls to Free with eligibility. Each affected workspace shows a split notice for 30 days (C9). Each OWNER of an affected account gets one email when the account's moves finish, in `apply` mode only. Never a bulk email. | billing (functions) · split (calls, notice, email) |
| 1 | No reuse. "Create workspace" always creates a new account; only an idempotent replay (same `idempotency_key`) returns an existing one. Delete `reusableOwnedAccount`'s empty-account branch. A deleted workspace's account is closing and can never come back. | identity |
| 2 | "Delete account" deletes the PERSON, never `resolveAccountId`'s earliest workspace. Plan per membership: sole owner and only member → delete that workspace; sole owner with other members → `409 sole_owner_of_shared_workspace` with `workspaces: [{workspace_id, name, member_count}]`; otherwise leave. `deleteLogin(userId)` runs last. `DELETE /v1/account/delete-immediately` runs the plan now. `POST /v1/account/request-deletion` writes `kortix.person_deletion_requests` (14 days); the account-deletion worker runs the plan when it is due. | identity |
| 3, 4 | Membership is access. Engine rule (C3): an account-scope `member` reaches its account's workspace at the `member` tier when the workspace is not `split_pending`. Existing members without a project grant gain access with no data migration. Invites default to role `member` and need no `project_grants` on a 1:1 workspace. `split_pending` accounts keep per-project grants. | auth |
| 5 | The split never duplicates a rotating credential (`codex`/`CODEX_AUTH_JSON`; an OpenCode login whose value parses as an OAuth login). It goes to the workspace that used it most recently (newest session pool reference, else the project of the owner's newest session). The other side gets an inactive placeholder with `needs_reauth_at = now()`, which the UI shows as "Reconnect". Both decisions go into `copied_ids`; reverse undoes them. The dry-run plan reports the count. The Codex and OpenCode refresh writes match by `secret_id` only and check the refresh token they used. | split |
| 6 | One "reaches the moved project" rule for memberships, groups and account-scope grant copies: a project grant on it, an owner/admin or custom account role, a group holding one of those, a project-secret grant, or super admin. An account `member` grant alone never counts. I8 is rewritten on the same rule (a shared SQL fragment). Fixtures get the real shape (every member holds account `member`). | split |
| 7 | The move carries `account_model_preferences` rows keyed by `scope='project', scope_key=<project_id>` (delete a stale target row first). The split path copies the source's `scope='account'` default. Both accounts' model-default caches are invalidated after commit. An invariant and a transfer test cover `scope_key` rows. | split |
| 8 | Legacy Stripe sync adopts only a subscription whose customer maps to this account (or is unmapped and whose `metadata.account_id` is empty or this account). No email search across customers. Never rewrite a `metadata.account_id` that names another live account. Refuse when another `credit_accounts` row holds the subscription id. The sync leaves the hourly request path (`resolveAccountId`); only `POST /v1/billing/sync-subscription` runs it. Invariant I11. | billing |
| 9 | Same as 1, plus the integration tests: an owned account with only an archived project is not reused; an owned account with a second member is not reused. | identity |
| 10 | `account-state` adds `credits.free_grant` and returns `tier.monthly_credits: 0` and `credits.expires_at: null` when the workspace is not eligible; `initializeFreeTierAccount({freeCredits:false})` stops writing `next_credit_grant` (C6). The billing modal treats a Free workspace that can buy credits and sits below the run floor as top-up-first. The Plan tab and the modal say where the free credits are (from `free_grant`); the create form states the rule ("Only your first workspace gets the monthly free credits."). | billing (API, SDK, billing UI) · web (create form) |
| 11 | Credentials bind (C4). Workspace settings → API keys mints workspace keys only (`POST /v1/workspaces/:id/tokens`), so "Whole workspace" is true. Personal keys (`project_id IS NULL`: CLI login, legacy `/v1/accounts/tokens`) act as the person and are listed under Preferences → Personal keys (`GET /v1/me/tokens`). Binding OAuth grants per workspace is a follow-up. | auth · api (SDK) · web |
| 12 | The workspace session policy (lifetime, idle, force-logout) is enforced in `actorOf` (`middleware/actor.ts`), memoized per request: every request that builds an actor for a workspace and carries a Supabase session is checked against that workspace. `GET /v1/workspaces` omits a workspace where this session is revoked. No global GoTrue revoke (it would sign the person out of every workspace). | auth |
| 13 | The `/v1/workspaces` IAM wire shows one scope: `/iam/roles` returns the four ladder roles plus custom roles (one `member` row, no `agent-user`); `/iam/permissions` emits `workspace_action` and `scope_type: 'workspace'`; `/iam/assignments` rows add `scope_type: 'workspace'` and `workspace_id` next to the legacy fields. `GET /v1/workspaces/:id/secret-resources` defaults `project_id` to the path workspace. | auth · api (secret-resources default) |
| 14 | Impersonation refuses every state-changing method under `/v1/accounts/:id/iam/**` (one subtree rule; only `iam/members/:id/effective(:batch)` stays open), and `DELETE` on the workspace. `assignRole` refuses an impersonating writer (`impersonation_invalid`). An account-scope assignment to a non-member also writes the membership, so the holder shows in Members. | auth |
| 15 | Fixed by K1: a person's workspace key manages its own workspace per the person's role. The SDK no longer lists `createAccountToken → createWorkspaceToken` as an exact equivalent (different reach). Fence refusals carry `code: 'credential_fence_refused'` and workspace wording. | auth · api (SDK) |
| 16 | Canonical paths take workspace ids only (C5). An account id, an unknown id, a tombstone or a workspace the caller cannot read answers `404 workspace_not_found` on every sub-path, so existence cannot be probed. Legacy paths keep the either-id tolerance. SDK workspace helpers pass workspace ids. | api |
| 17 | OpenAPI: a `Workspace` schema from the route's own zod object; one alias source (`workspaceAliasOf` in `packages/shared/src/workspace-routes.ts`) for the spec and the route manifest; `WORKSPACE_MERGED_LEGACY_ROUTES` respected; whole-segment param regex (custom verbs survive); a `workspaces` tag and canonical summaries; a unit test compares the spec's alias set with `tests/spec/routes.generated.json`. | api |
| 18 | `developers.mdx` and the SDK README get one canonical route table (canonical ↔ legacy), the error table (`workspace_has_project` with `workspace_id`, `workspace_not_found`, `workspace_setup_required`, `workspace_deleting`, `workspace_setting_read_only`), and the corrected provision row. The SDK exports `WORKSPACE_HAS_PROJECT_CODE`, `isWorkspaceHasProjectError` and the new codes. | api |
| 19 | The invite dialog is "Invite people to {workspace}": email chips, one role select (Member / Manager / Admin; Owner by transfer only), optional expiry. The per-project rows show only on a `split_pending` workspace. Members and Access merge into one Members table with one role column. | web |
| 20 | A copy pass by meaning, not by search-and-replace: the access screen labels "Signed in as" and shows the workspace name; pause, Files quota, groups and model-default copy say "this workspace"; the palette copies the workspace id; the API denial strings (`projects/lib/project-access.ts`) say "workspace"; the 5 Serbian leftovers. No regex catalog test (it fails on correct copy). Hide the project-groups card while an account has ≤ 1 project. | web · auth (API strings) |
| 21 | The workspace menu: header (icon, name, role) → "Invite people to {name}" → "Workspace settings" → workspace list with the pending-invitation count → "Create workspace" → "Preferences" (keeps Mod+,) → Appearance, Help, Download app → "Leave {name}" (not for the last owner) → Log out. Customize → Settings is renamed "Workspace settings" or removed. `ux.md` §3 changes in the same commit. | web |
| 22 | The CLI has one workspace context: `--workspace`/`--project` → `KORTIX_WORKSPACE_ID` → `KORTIX_PROJECT_ID` → the directory link → the default workspace, passed as `account_id` to account routes. `--account` stays as a hidden alias through the same resolver. `members invite --workspace <id>:<r>` becomes `--grant <id>:<role>` (split_pending only). A subcommand refuses a flag it consumes but does not use. | runtime |
| 23 | Agent-facing vocabulary says workspace: the My Kortix prompt (no "workspace → project" row; real UI paths from C7's registry), the kortixd `kortix_access`/`kortix_people` strings (one "Workspace role" row), the starter `kortix.yaml` comments, `agents/worker.md`, the managed skills, and the `kortix-ui` route defaults (`/workspaces/<id>`). The prompt's "where to click" table is built from `WORKSPACE_SETTINGS_SECTIONS`, so a section rename cannot leave it stale. | runtime |
| 24 | `kortix whoami` reads `/v1/accounts/me`: a bound token prints `token_context.workspace_id`; no list read. `kortix workspaces ls` with a bound token prints its one workspace. Neither prints "No workspace yet" after a failed read. | runtime |
| 25 | Fixed by K1 and C8: former account actions are ordinary grantable workspace actions. The validator, `kortix validate --scopes` and the CLI denial hint follow; a fence 403 (typed `credential_fence_refused`) never tells an agent to edit `kortix_permissions`. `/access` routes become thin aliases of the Members services. | auth · runtime |
| 26 | `PATCH /v1/workspaces/:id` accepts the project fields only; a settings key answers `400 workspace_setting_read_only` with `field` and `writer` (the sub-route). Delete `updateWorkspace`, `splitWorkspacePatch` and `WorkspacePatch` (dead code that bypassed audit and cache invalidation). | api · identity |
| 27 | A trigger keeps `split_pending` true exactly while the account holds 2+ active project rows (`AFTER INSERT OR UPDATE OF status, account_id`, depth-guarded). The two app-level recomputes go. I1 adds the reverse check. The split planner sweeps stale flags once. | identity · split |
| 28 | The `workspaceNameBackups` comment points to the M2 header's trigger-disabling rollback instead of carrying its own SQL. | identity |
| 29 | M1 locks one hot table per file: the accounts name-sync function and trigger move to their own `.sql` file. Headers and this file state the real 55P03 procedure: the batch rolls back, find the holder in `pg_stat_activity`, rerun, never raise the timeout. | identity |
| 30 | `/quota` (legacy name only) answers the workspace rule from the create gate (`capped` = the account holds its project, `limit: 1`, no upgrade copy). Delete `projectQuotaDenial`, the `project_limit_reached` branch and `MAX_PROJECTS_PER_ACCOUNT`; the SDK keeps the code as deprecated. The transfer target check becomes `workspaceHasProjectDenial`. | api (quota) · split (transfer) · billing (copy) |
| 31 | Session and workspace cost views read `gateway_request_logs` by `project_id` (+ `session_id`), authorized on the workspace; rows billed to another account are marked "billed to the previous workspace". Account money totals stay by `account_id`. The keeper labels a moved project "Moved to another workspace". | billing |
| 32 | After a run reaches `done`, the runner schedules one repair pass at `completed_at + 120 s`: the move's own per-table `UPDATE … WHERE project_id = P AND account_id = <from>`, then I2 for that run. After commit it publishes the project-scoped IAM cache bust (LISTEN/NOTIFY reaches API replicas). | split |
| 33 | Pricing copy comes from the same facts object as `pricing-plans.ts`: "500 credits a month on your first workspace", no "for 1 workspace", no "managed models" on Free. `text79c0703d2226` is fixed or deleted. | billing |
| 34 | The `409 workspace_ambiguous` body drops `workspace_ids`. uuid path params are lowercased once at the edge (resolver, fence params, rate-limit keys). | auth (409) · api (lowercase) |
| 35 | Every serializer that emits `project_id` also emits `workspace_id` (sessions, tokens, access, members, secrets, triggers). Workspace records carry a top-level `role` (ladder) and `state`. | api |
| 36 | The SDK workspace handle is built from an explicit key list: project CLI tokens stay reachable as `workspace(id).cliTokens`; a test lists every overridden key. `createWorkspace` returns `Workspace`. New: `deleteWorkspace`, `restoreWorkspace`, `setupWorkspace`, `listPersonalTokens`, `revokePersonalToken`, `getPersonDeletionPlan`. New public names say workspace. | api |
| 37 | The Profile tab's workspace list is deleted; the rail is the one list (it closes the dialog through `ModalClose`). | web |
| 38 | The chooser renders the handoff whenever `inlineCreate.submitting` is true, whatever the list holds. | web |
| 39 | Outputs lead with the workspace name: the 403 body adds `workspace_action`; denial messages print the workspace name; `validate --scopes` lists `workspace.*` with a "legacy names, still accepted" section; `kortix validate --fix` rewrites `project.*` grants to `workspace.*`; `kortix-yaml.md` documents `workspace.*`. | auth · runtime |
| 40 | `kortix tui --workspace/--project` sets both `KORTIX_WORKSPACE_ID` and `KORTIX_PROJECT_ID` in the child; the TUI then reads `KORTIX_WORKSPACE_ID` first, as the CLI and kortixd do. The `workspace:` manifest key rename is out of scope. | runtime |

### 3.2 Cross-stream contracts

Every stream codes against these names, signatures and semantics. A stream that needs a
change here asks the orchestrator first; the change lands in this file before the code.

#### C1. Identity, ids and lifecycle

- `workspace_id` = the account's active project id when it has one; else the account id (a
  project-less workspace). Once served, a `workspace_id` never changes. A project row
  provisioned into a project-less workspace (Set up, C5) gets `project_id := workspace_id`.
  A new workspace (`POST /v1/workspaces`) gets a fresh random project id, distinct from
  its account id.
- `kortix.workspaces` is a TABLE in R1, derived from `accounts`, `projects` and
  `account_deletion_requests` by triggers. It holds one row per project row (any status)
  plus one row per account that has no project row. Columns: `workspace_id` PK,
  `legacy_account_id` (NULL only on a tombstone), `former_account_id` (tombstones only),
  `project_id` (= `workspace_id` or NULL; CHECK), `lifecycle`, `split_pending`, `name`, the
  config-repo columns and `project_status`, the settings columns, `deletion_scheduled_for`,
  `created_at`, `updated_at`, `synced_at`. Unique: `(legacy_account_id) WHERE lifecycle <>
  'tombstone' AND NOT split_pending`. Index: `(legacy_account_id)`.
- **Live-row rule**, per account, in order:
  1. Each active project row is live (`active`, or `closing` while a deletion request is
     open). A `split_pending` account has several.
  2. Else, while a deletion request is open and the account has archived project rows: the
     most recently archived one is live (`closing`). A deleted workspace keeps its id
     during the grace.
  3. Else: the project-less row (`workspace_id = account_id`) is live (`dormant`, or
     `closing`).
  4. Every other project row is a `tombstone` (`legacy_account_id` NULL, `former_account_id`
     set).
- **API `state`** (derived, never stored): `active` (lifecycle `active`); `setup_required`
  (lifecycle `dormant` AND `kortix.account_is_paying`); `deleting` (lifecycle `closing`,
  served to owners only). A dormant non-paying workspace and a tombstone are never served.
- SQL functions (R1 migrations, identity):
  - `kortix.workspaces_expected(account_id uuid) RETURNS SETOF kortix.workspaces` — the
    live-row rule over the base tables. The one implementation.
  - `kortix.workspaces_reconcile_account(account_id uuid) RETURNS void` — takes
    `pg_advisory_xact_lock(hashtextextended('kortix:workspaces:'||account_id, 0))`, upserts
    `workspaces_expected`, deletes the account's other rows. Idempotent.
  - `kortix.workspace_id_of_account(account_id uuid) RETURNS uuid` (STABLE) — the live,
    non-`split_pending`, non-tombstone row's id; NULL when none or ambiguous.
  - `kortix.workspace_fill_account(account_id uuid) RETURNS integer` — sets `workspace_id`
    on every expand-table row of the account to `workspace_id_of_account`; returns the row
    count. The split calls it after an account's last move.
  - `kortix.account_is_paying(account_id uuid) RETURNS boolean` (STABLE) — C6.

#### C2. The workspaces store (`apps/api/src/workspaces/surface.ts`)

The only import path for workspace identity and lifecycle. The lint rule
(`kortix-api/workspace-store-only`, `apps/api/eslint.config.mjs`) refuses an import of
`accounts`, `projects` or `workspaces` from `@kortix/db` outside `apps/api/src/workspaces/**`
(static, `await import('@kortix/db')` destructuring, and re-exports). Tests and
`apps/api/src/scripts/**` are outside the API lint. It has no suppression (2026-11-06).

Account and project ROWS go through `apps/api/src/workspaces/rows.ts`, a leaf module in
the shared lint layer:

- Reads compose `projectsView` / `accountsView`. At runtime each is the table object, so a
  read renders the same SQL; to the compiler each is a view, so `db.update(projectsView)`
  does not compile (`rows.test.ts` holds that with `@ts-expect-error`).
- Writes are functions: `updateProjectRows[Returning]`, `insertProjectRow`,
  `deleteProjectRows`, `moveProjectRowAccount` (the transfer and the split), and the account
  equivalents. A project write's `metadata` is SQL by type (`ProjectRowSet`): the FIX-J
  merge helpers (`metadataMerge`, `metadataMergeSubtree`, `metadataClearSubtreeKey`) or
  `metadataReplace` under a `FOR UPDATE` lock.
- Release 2 changes these write functions to write `kortix.workspaces` (and the reads keep
  working against `accounts` / `projects` as compatibility views). No other module writes
  the two tables.

```ts
// kept as they are: asWorkspaceId, asWorkspaceAccountKey, isUuid, WorkspaceId,
// WorkspaceAccountKey, pickWorkspace, WORKSPACE_AMBIGUOUS_CODE, WorkspaceAmbiguousError,
// ResolvedWorkspace, and the one-project.ts exports.
// removed (finding 26): updateWorkspace, splitWorkspacePatch, WorkspacePatch.
export type WorkspaceLifecycle = 'active' | 'dormant' | 'closing' | 'tombstone';
export type WorkspaceState = 'active' | 'setup_required' | 'deleting';

/** One live row of kortix.workspaces (never a tombstone). */
export interface WorkspaceRecord {
  workspaceId: WorkspaceId;
  accountId: WorkspaceAccountKey;        // legacy_account_id
  projectId: WorkspaceId | null;         // = workspaceId, or null before Set up
  lifecycle: Exclude<WorkspaceLifecycle, 'tombstone'>;
  splitPending: boolean;
  name: string;
  deletionScheduledFor: Date | null;
  // plus every config-repo and settings column of the table, camelCase
}
export interface WorkspaceCandidate {
  record: WorkspaceRecord;
  paying: boolean;                       // kortix.account_is_paying(accountId)
  accountRole: 'owner' | 'admin' | 'member' | null; // the user's system account role, or null (project grant only)
}

export function getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null>;
/** Legacy routes: a workspace id or a legacy account key. Throws WorkspaceAmbiguousError. */
export function resolveWorkspace(idOrLegacyAccountId: string): Promise<ResolvedWorkspace | null>;
/** Canonical routes: a workspace id only. Account ids, tombstones and unknown ids give null. */
export function resolveCanonicalWorkspace(workspaceId: string): Promise<ResolvedWorkspace | null>;
/** Null for an unknown or split_pending account. */
export function workspaceIdOfAccount(accountId: string): Promise<WorkspaceId | null>;
/** Every live row of every account where the user has a membership or a grant. One query. */
export function listUserWorkspaceCandidates(userId: string): Promise<WorkspaceCandidate[]>;
/** Pure. Null = never served. */
export function workspaceState(record: WorkspaceRecord, paying: boolean): WorkspaceState | null;

export function closeWorkspace(input: { workspaceId: WorkspaceId; actorUserId: string }):
  Promise<{ mode: 'closed'; deletionScheduledFor: Date } | { mode: 'archived_project' }>;
export function restoreWorkspace(input: { workspaceId: WorkspaceId; actorUserId: string }): Promise<WorkspaceRecord>;
export function prepareWorkspaceSetup(workspaceId: WorkspaceId): Promise<{ accountId: WorkspaceAccountKey; projectId: WorkspaceId }>;

export interface PersonDeletionPlan {
  deleteWorkspaces: WorkspaceId[];
  leaveWorkspaces: WorkspaceId[];
  blockers: Array<{ workspaceId: WorkspaceId; name: string; memberCount: number }>;
}
export function planPersonDeletion(userId: string): Promise<PersonDeletionPlan>;
export function deletePerson(userId: string, when: 'now' | 'scheduled'):
  Promise<{ plan: PersonDeletionPlan; scheduledFor: Date | null }>;
```

Shadow reads (R1): `getWorkspace`, `resolveWorkspace`, `resolveCanonicalWorkspace` and
`listUserWorkspaceCandidates` answer from `kortix.workspaces_expected` (primary) and read
the table row (shadow). A difference logs `[workspaces] shadow_mismatch` with
`workspace_id` and the differing field NAMES (never values) and increments
`kortix_workspace_shadow_mismatch_total{field}`. R2 flips primary and shadow.

#### C3. Membership is access; one role ladder

- Ladder: `owner > admin > manager > member` (`WorkspaceRole`, SDK). Storage stays in R1:
  owner/admin = the account-scope system role; manager = account `member` + project
  `manager` on the workspace's project row; member = account `member`.
- Engine rule (auth, `iam/authorize.ts`): an account-scope system `member` assignment reaches
  its account's workspace at the project `member` tier when that workspace is not
  `split_pending`. Applied in `authorize` (`effectiveProjectRole`), `listAccessibleProjects`,
  `filterAccessibleObjects` and the visibility read. Object grants (step 9) still apply.
- A principal's role in W: owner/admin from the account role; else `manager` when it holds
  project `manager` on W (directly or through a group); else `member` when it is an account
  member (1:1) or holds a project grant (`split_pending`); else no access. auth exports the
  one implementation from `apps/api/src/iam/index.ts`:
  `workspaceRoleFor(actor: Actor, workspaceId: string): Promise<WorkspaceRole | null>`
  (`WorkspaceRole = 'owner' | 'admin' | 'manager' | 'member'`). The list, the record and
  the Members table all call it.
- A closing workspace (lifecycle `closing`): every principal is denied except owners, who
  keep `workspace.read`, `workspace.billing.read` and restore. The canonical resolver maps
  the non-owner denial to 404 `workspace_not_found`; an owner's other calls get
  `409 workspace_deleting`.
- Writes:
  - `POST /v1/workspaces/:id/members` `{ email, role?: 'admin'|'manager'|'member' = 'member', expires_at? }`.
    Authorized by `member.invite` OR `project.members.manage` on W; `admin` needs
    `member.update`. `project_grants` is honored on a `split_pending` workspace, accepted
    and ignored when it names W only, and `400` when it names another project.
  - `PATCH /v1/workspaces/:id/members/:userId` `{ role: WorkspaceRole }`; owner only by an
    owner (today's rule); manager writes account member + exclusive project manager;
    member removes the project manager row.
  - Every path that creates a membership (invite add, invite accept, `/v1/accounts`
    auto-claim, SSO JIT, SCIM) goes through one helper,
    `addWorkspaceMember(accountId, userId, role, explicitProjectGrants?)`.
  - `/v1/workspaces/:id/access`, `/access/invite`, `/access/pending-invites` stay as thin
    aliases of the same services and authorization.

#### C4. Credential binding: one fence rule

- **Workspace-bound credentials**: `account_tokens.project_id = W` (workspace keys from
  Workspace settings → API keys and `POST /v1/workspaces/:id/tokens`, project CLI tokens,
  session tokens `KORTIX_TOKEN` including agent sessions), service-account bearers (W =
  their account's workspace), workspace gateway keys.
- **Person credentials**: the Supabase JWT; personal keys (`account_tokens.project_id IS
  NULL`: the CLI device login, legacy `POST /v1/accounts/tokens`); OAuth access tokens
  (binding them per workspace is a follow-up). They act as the person in each workspace;
  `authorize` decides per workspace. The fence does not judge them.
- **The rule**: a workspace-bound credential reaches a request iff the request's workspace
  is its own. Binding kinds in `middleware/workspace-binding.ts`:
  - `path` — `:workspaceId`; `/v1/accounts/:accountId/**` through `workspace_id_of_account`
    (a `split_pending` account is refused: `account-wider-than-workspace`).
  - `resource` — sandbox, drive, artifact, session (unchanged).
  - `ambient` with `reach: 'credential'` — the handler scopes to the credential's workspace:
    `GET /v1/workspaces` and `GET /v1/projects` return that one workspace;
    `/v1/projects/current`, `/v1/workspaces/current`, cost summaries, `capture/me`.
  - `ambient` with `reach: 'param'` — `account_id`, `workspace_id` or `project_id` in the
    query or body names the workspace (bijection); it must be the credential's.
  - `platform` — admin, router, platform and global surfaces: refused.
  - `person` — the person's own surfaces (inbox, Chrome, private tunnel machines, invite
    accept, `/v1/me/tokens`): refused for a workspace-bound credential, except `/v1/me`
    and `/v1/accounts/me` (identity).
  - `none` — no workspace data (unchanged).
  - The `admin` flag is deleted.
- Refusal: `403 { code: 'credential_fence_refused', check, message }`. The message reads
  "This workspace key cannot …" and keeps `[check=token-project-scope:<check> …]` for log
  searches. Checks: `cross-workspace`, `account-wider-than-workspace`, `platform-route`,
  `person-route`, `foreign-sandbox`, `default-deny`.
- `tokenScopeAllows` and `agentPrincipalDecision`: an account-scope action is in scope for
  a bound credential when the actor's account is the credential workspace's account and
  that workspace is not `split_pending`.
- Mint and list: Workspace settings mints workspace keys only. `GET /v1/workspaces/:id/tokens`
  lists W's keys. `GET /v1/me/tokens` lists the caller's personal keys across workspaces;
  `DELETE /v1/me/tokens/:tokenId` revokes one. Minting is `HUMAN_ONLY`.
- Session policy: `actorOf(c, accountId)` evaluates the account's session policy for a
  Supabase session (`loadPolicyAndActivity` + `evaluateSessionGate`) and throws
  `401 session_token_revoked`. One choke point for every authorized route.

#### C5. Canonical routes, ids, response shapes, error codes

New or changed canonical routes:

| Route | Semantics |
|---|---|
| `GET /v1/workspaces` | Every workspace the caller may see, all accounts, one request. Items: the project record fields (`serializeProject`) plus `workspace_id`, `role`, `state`, `split_pending`, `deletion_scheduled_for`; a `setup_required` item has `project_id = workspace_id` and empty config-repo fields. Order: `last_opened_at DESC NULLS LAST, name, workspace_id`. Includes `setup_required` (members) and `deleting` (owners). A bound credential gets its one workspace. |
| `POST /v1/workspaces` | Body: `name` (1–255, trimmed), `icon?`, the repository fields `POST /v1/projects/provision` accepts minus `account_id`/`new_workspace`, `idempotency_key?`. Always a new account (C1). `Accept: text/event-stream` streams the existing provision events and ends with the workspace. `201 Workspace`. `403 new_workspace_requires_person` (bound credential, API key, service account), `403 account_creation_restricted`, `403 impersonation_invalid`, `409 provision_in_flight`. |
| `GET /v1/workspaces/:id` | `Workspace`: the record plus top-level `role` and `state` plus the `workspace` settings block. |
| `PATCH /v1/workspaces/:id` | `name`, `icon`, `secret_default_strategy`. A settings key → `400 workspace_setting_read_only { field, writer }`. |
| `DELETE /v1/workspaces/:id` | K2. `200 { ok: true, deleted: true, archived: true, repo_deleted: false, deletion_scheduled_for }`. `split_pending`: archive only, `deletion_scheduled_for: null`. |
| `POST /v1/workspaces/:id/restore` | Owners, while `deleting`. `200 Workspace`. |
| `POST /v1/workspaces/:id/setup` | A `setup_required` workspace: provisions its config repo with `project_id = workspace_id`. `201 Workspace`. Same caller rules as create. |
| `GET /v1/me/tokens`, `DELETE /v1/me/tokens/:tokenId` | Personal keys (C4). |
| `GET /v1/account/deletion-plan` | The caller's `PersonDeletionPlan` (C2), for the "Delete my account" dialog. Person route. |
| `/v1/workspaces/:id/<family>` | The account families of `WORKSPACE_ACCOUNT_FAMILIES`, with `secret-resources` defaulting `project_id` to W. |

`GET /v1/workspaces` composition: `listUserWorkspaceCandidates(userId)` (C2) → per account,
`actorOf(c, accountId)` (an account whose session policy revokes this session throws
`session_token_revoked`: skip that account) → `listAccessible(actor, 'workspace.read',
'workspace')` → `workspaceRoleFor` (C3) → `workspaceState` (C2). Every route this section
adds needs a binding row in `middleware/workspace-binding.ts` (auth adds the wave-1 rows from
this table; a wave-2 stream adds the row for a route it adds).

- Id rules: canonical paths (`/v1/workspaces/**`, `/v1/connectors/workspaces/**`,
  `/scim/v2/workspaces/**`) take workspace ids only. Input uuids are case-insensitive;
  output is lowercase. An account id, unknown id, tombstone, dormant non-paying workspace or
  a workspace the caller cannot read → `404 { code: 'workspace_not_found' }` on every
  sub-path. A `setup_required` workspace → `409 workspace_setup_required` on project-backed
  sub-paths (sessions, agents, files, …); account families answer. Legacy paths keep
  either-id tolerance and their old status codes.
- Every record that names a workspace carries `workspace_id` (= `project_id`). `account_id`
  stays and is documented deprecated. Lists (legacy `GET /v1/accounts` included) apply the
  closing visibility rule (owners only).
- Error codes: `workspace_not_found` 404 · `workspace_setup_required` 409 ·
  `workspace_deleting` 409 · `workspace_has_project` 409 (with `workspace_id`) ·
  `workspace_ambiguous` 409 (no id list) · `workspace_setting_read_only` 400 ·
  `sole_owner_of_shared_workspace` 409 · `new_workspace_requires_person` 403 ·
  `account_creation_restricted` 403 · `credential_fence_refused` 403 · `no_workspace` 409
  (unchanged) · `session_token_revoked` 401.

#### C6. Billing functions

- `kortix.account_is_paying(account_id)` (SQL, created by identity in R1, semantics owned by
  billing): `tier NOT IN ('free','none')` OR `lifetime_purchased_precise > 0` OR a completed
  `credit_purchases` row OR an active `enterprise_contracts` row. A `stripe_subscription_id`
  alone never counts. TS wrapper (billing): `isPayingAccount(accountId): Promise<boolean>`.
- `applySplitOffBilling(input: { runId: string; sourceAccountId: string; newAccountId: string }): Promise<SplitOffBilling>`
  ```ts
  type SplitOffBilling =
    | { kind: 'free'; grantedCredits: number }
    | { kind: 'comped'; tier: string; planMonthlyUsd: number; compedUntil: string; grantedCredits: number };
  ```
  Free source: Free plan, `free_credits_eligible = true`, one Free monthly grant now (wallet
  key `split_off_grant:<runId>`), no `free_credit_claims` row. Paying source: the keeper's
  plan comped, no Stripe subscription, until `min(keeper's current period end, now + 31 d)`
  (`credit_accounts.comp_plan_until`, new column); grant = plan monthly credits × remaining
  days / period days, expiring at `compedUntil` (key `split_off_comp:<runId>`). At
  `compedUntil` the billing rotation moves the account to Free with eligibility. Written
  through the audited billing service path. Idempotent per `runId`.
- `previewSplitOffBilling(sourceAccountId): Promise<{ kind: 'free' | 'comped'; compedUntil: string | null; credits: number }>`
  for the dry-run aggregates (the total comp credits is reported before `apply`).
- `reverseSplitOffBilling(input: { runId: string; newAccountId: string }): Promise<void>`:
  clears the comp and forfeits unspent split-off credits; refuses when the account took
  money (the split's reverse already refuses that case).
- Lifecycle uses the existing `cancelSubscription(accountId, 'workspace_deleted')` and
  `reactivateSubscription(accountId)` (`billing/services/subscriptions.ts`).
- `GET /v1/billing/account-state` adds `credits.free_grant: { eligible: boolean;
  claimed_workspace_id: string | null }` (`claimed_workspace_id` only when the caller is a
  member of it) and `plan_comp: { until: string; source: 'workspace_split' } | null`. Not
  eligible → `tier.monthly_credits: 0`, `credits.expires_at: null`.
- Free credits once per person (`free-credit-claims.ts`, identity): an owned account counts
  as "another workspace" only when it has a project row or pays. A legacy person whose only
  account is a dormant sign-up account gets the grant on their first created workspace.

#### C7. The one Settings panel and Preferences

`packages/shared/src/workspace-settings.ts` (new, api creates it; web and runtime import it)
is the registry the UI, the CLI, the API emails and the My Kortix prompt all read:

```ts
export const WORKSPACE_SETTINGS_GROUPS = [
  { id: 'workspace', sections: ['general', 'security', 'branding', 'git', 'sandbox', 'feature-flags', 'api-keys', 'capture'] },
  { id: 'library',   sections: ['connectors', 'secrets', 'skills', 'drives', 'apps', 'triggers', 'models', 'repo'] },
  { id: 'people',    sections: ['members', 'groups', 'roles', 'identity', 'audit'] },
  { id: 'billing',   sections: ['plan', 'usage'] },
  { id: 'support',   sections: ['help'] },
] as const;
export type WorkspaceSettingsSection = (typeof WORKSPACE_SETTINGS_GROUPS)[number]['sections'][number];
/** Old ids and old account-hub tabs → the section that owns them now. */
export const WORKSPACE_SETTINGS_SECTION_ALIASES: Readonly<Record<string, WorkspaceSettingsSection>> = {
  access: 'members', 'access-projects': 'members', settings: 'security', tokens: 'api-keys',
  billing: 'plan', credits: 'plan', transactions: 'usage', connected: 'git', loops: 'triggers',
};
/** English labels (the en catalog uses the same words; a web test holds them equal). */
export const WORKSPACE_SETTINGS_LABELS: Readonly<Record<WorkspaceSettingsSection, string>>;
export function workspaceSettingsPath(workspaceId: string, section?: WorkspaceSettingsSection): string; // `/workspaces/<id>/admin/<section>`
export function parseWorkspaceSettingsSection(raw: string | null | undefined): WorkspaceSettingsSection | null; // aliases resolved
```

- One panel per workspace, top to bottom in this order, at `/workspaces/<id>/admin/<section>`
  (Slack's `/admin`); `/admin` opens `general`. `general` = name, icon, workspace id, and
  the danger zone (Leave, Delete). `security` = MFA, session policy, key policy, session
  oversight (moved out of General). `capture` shows only while Capture is on. Each row keeps
  its own permission gate.
- Legacy URLs redirect: `/projects/<id>/admin/<s>`; `/workspaces/<id>/admin/access`;
  `?accountId=&accountTab=<tab>`; `/settings/{tokens,plan,credits,connected}`;
  `/workspaces/<id>/members`.
- Preferences (the person's own settings) stays an overlay. Tabs: profile, security,
  appearance, sessions, preferences, chrome, mcp, computer, and the new `personal-keys`.
  Its deep link `/workspaces/<id>/settings/<tab>` does not change (the API and CLI link
  `/settings/chrome`). Menu label: "Preferences".
- Every link the API, CLI, skills and emails print is built with `workspaceSettingsPath`.

#### C8. Permission vocabulary

- Names: the 85 `workspace.*` names of `WORKSPACE_ACTION_BY_LEGACY`
  (`packages/shared/src/workspace-actions.ts`), unchanged. Storage keeps legacy strings in
  R1. Inputs accept both names forever.
- Outputs lead with the workspace name: every 403 body is
  `{ error: true, message, status: 403, code, action, workspace_action }` (`action` stays
  the legacy name for old clients); messages print the workspace name; `/iam/permissions`
  and `/iam/actions` emit `workspace_action` and `scope_type: 'workspace'`.
- `HUMAN_ONLY` (new export, `packages/shared/src/workspace-actions.ts`; legacy names):
  `token.create`, `token.personal.create`, `project.credentials.issue`,
  `project.gateway.keys.manage` (minting credentials), `billing.write`, `account.delete`,
  `project.delete` (moving money: checkout, payment methods, top-up approval, and deleting
  a workspace, which cancels its subscription and forfeits its wallet). No agent session,
  inherited or governed, ever passes these. The SCIM token mint asserts `token.create`.
- Grantable to agents (`GRANTABLE_KORTIX_PERMISSIONS`, `packages/manifest-schema`): every
  action except `HUMAN_ONLY`, both spellings; `"*"` = all grantable.
- Default ceiling of a governed agent with no bound role: every grantable action.
- Denial reasons added: `workspace_closed` (mapped to 404/409, C3), and
  `agent_human_only_action` now covers every agent session.

#### C9. Split notice and owner email

- `GET /v1/workspaces/:id` adds `split_notice: { role: 'keeper' | 'moved'; source_name:
  string; completed_at: string; billing: 'free' | 'comped' | null; comped_until: string |
  null } | null`, for 30 days after the account's last move (derived from
  `workspace_split_runs`).
- Owner email: one per (owner, source account) when the account's last move is `done`;
  `apply` mode only; idempotency key `workspace-split-email:<from_account_id>:<user_id>`
  recorded in the run's `plan`; owners only; never in `dry_run`.

#### C10. Flow ids, contract-first commits, merge order

- Flow id ranges (`tests/spec/end-to-end.md`): identity `WS-LIFE-*`, `DEL-7`, `DEL-8`;
  auth `WS-AUTH-*`; api `WS-ROUTE-*` (1–3 rewritten for K3, new from 4); runtime `CLI-WS-*`;
  billing `BILL-WS-*`; split uses the DB suite; web extends the Playwright journeys named in
  the PR and adds one settings journey.
- Each stream's first commit implements its contract surface (exports with the signatures
  above, delegating to existing code where the behavior is not built yet) and is pushed
  within the stream's first hours; dependent streams merge that commit.
- Step 0 (orchestrator, before any sub-branch is cut): merge `origin/dev` into `workspaces`
  (PR #11857 reports CONFLICTING; `origin/dev` moved on 2026-11-06) and push.
- Integration: wave 1 merges into `workspaces` in the order identity → auth → api →
  runtime; wave 2 in the order billing → split → web. After each merge: T0 for the touched
  packages, the stream's covering tests one by one, and its real-surface proof.
- Shared seams, named once: the `split_pending` trigger (identity) makes the two
  `recomputeSplitPending` calls in `project-transfer.ts` redundant; split removes them in
  wave 2. `provision-core.ts` belongs to api except identity's additive setup option.

### 3.3 Release 1 migrations, in order

Every file sorts after the newest migration on `origin/dev` at merge time (re-date before
merge if dev moved). Each `.sql` file is its own transaction (`RUNNER_TRANSACTION_MODE`).
A 55P03 rolls the file back: find the holder in `pg_stat_activity`, rerun, never raise the
timeout (the `20261011111553399_session_log_tables.sql` convention). No shared environment
(dev, staging, prod) has applied M1–M3 (previews never run migrations), so M1 may be edited.

| # | File | Content | Locks |
|---|---|---|---|
| M0 | `20261106140000000_free_credits_once_per_person.sql` (exists) | unchanged | — |
| M1 | `20261106140100000_workspaces_expand.sql` (edit) | `projects.split_pending`, the two ledger tables, the projects name-sync trigger. Remove the view and the accounts trigger. Fix the header (manual rerun). | `projects` only, 3 s |
| M1b | new `.sql` | `kortix.workspace_account_name_sync()` + `CREATE OR REPLACE TRIGGER accounts_name_sync` (idempotent on DBs that ran the old M1) | `accounts` only, 3 s |
| M2, M3 | exist | unchanged | — |
| M4 | new `.sql` | `DROP VIEW IF EXISTS kortix.workspaces`; `CREATE TABLE IF NOT EXISTS kortix.workspaces` (C1) + indexes + RLS + grants; `kortix.person_deletion_requests (user_id PK, requested_at, scheduled_for, status, completed_at)` + RLS; the five C1 functions | new objects only |
| M5a–c | new `.sql` ×3 | AFTER INSERT/UPDATE/DELETE row triggers calling `workspaces_reconcile_account`: on `projects` (the columns the table mirrors), on `accounts`, on `account_deletion_requests`; plus the `split_pending` trigger on `projects` (finding 27) | one table per file, 3 s |
| M6 | new `.concurrent.ts` (`// batched-dml:`) | `workspaces_reconcile_account` for every account, 500 per batch by `account_id` (~49k accounts) | row locks |
| M7a–n | new `.sql` | `ADD COLUMN workspace_id uuid` (nullable, no default: catalog-only) + `BEFORE INSERT OR UPDATE OF account_id` trigger `NEW.workspace_id := kortix.workspace_id_of_account(NEW.account_id)` on the 44 expand tables (§6.2). One file per hot table (`credit_ledger`, `credit_accounts`, `credit_usage`, `credit_purchases`, `sandbox_compute_sessions`, `account_session_activity`, `billing_customers`, `account_memberships`, `oauth_access_tokens`); the rest ≤ 8 per file | one hot table per file, 3 s |
| M8 | new `.concurrent.ts` (`// batched-dml:`) | Fill `workspace_id` where NULL: keyset on the primary key (`ctid` ranges for composite keys), 5,000 rows per batch, smallest table first, `pg_sleep(0.02)` between batches. Skips `split_pending` accounts (NULL until the split). Measure on the 1/20 prod-shape seed and record the scaled time in the PR (`credit_ledger` 8.6M rows dominates). | row locks |
| M9 | new `.sql` (billing, wave 2) | `credit_accounts.comp_plan_until timestamptz` | `credit_accounts`, 3 s |

**Built (identity, sub-branch `ws-r1-identity`, 2026-11-06).** The files, in
order: M1 `20261106140100000_workspaces_expand.sql` (edited); M1b
`20261106140400000_workspaces_account_name_sync.sql` (sorts after M2/M3: M2's
rename finds the names equal, so the order does not matter); M4
`20261106140600000_workspaces_table.sql` (plus `kortix.workspace_expand_tables()`,
the one list of the 44, and `kortix.workspace_id_stamp()`, the M7 trigger
function); M5a–c `20261106140700000`–`20261106140900000`; M6
`20261106141000000_workspaces_reconcile.concurrent.ts`; M7
`20261106141100000`–`20261106142500000` (9 hot tables one per file, then 5
files of ≤ 7); M8 `20261106142600000_workspace_id_fill.concurrent.ts`.
Decisions taken while building, each within C1:

- The reconcile takes the account row `FOR NO KEY UPDATE` before the advisory
  lock. A writer locks a project row before its account row; an advisory lock
  alone deadlocks a rename (project, then account) against a settings write
  (account, then reconcile). `FOR NO KEY UPDATE` does not block foreign-key
  checks of rows that reference the account.
- The reconcile deletes every row of the account that differs from its
  expected row, then inserts what is missing. An in-place update of two rows
  of one account (a tombstone coming back live while the live row turns
  tombstone) collides on `uq_workspaces_live_account`.
- When an account's live id moves from one non-NULL id to another (a new
  account's dormant row to its first project), the reconcile calls
  `workspace_fill_account`. A move from NULL (a `split_pending` account
  resolving) is left to the split runner, which fills both accounts after
  every move and reverse, and to M8: a keeper can hold millions of ledger rows.
- `resolveWorkspace` (legacy routes) keeps the old answer: only a workspace
  whose project row is active. `resolveCanonicalWorkspace` resolves active,
  dormant and closing rows. `ResolvedWorkspace` gains optional `lifecycle` and
  `projectId`; the resolver's candidate type is `WorkspaceResolveCandidate`
  (the name `WorkspaceCandidate` is C2's list item).
- A keyed create's concurrent attempt converges on the caller's virgin account
  created in the last 15 minutes (`virginAccountOf` in
  `projects/new-workspace.ts`: owned, only member, no project row, invitation,
  deletion request or foreign grant). It is a replay of the same create, never
  a reuse: a deleted workspace and a shared account never match.
- `oauth_refresh_tokens` carries `account_id` only and is in neither §6.2 list.
  It is classified `excluded` in `workspace-key-classes.ts` with a note:
  classify it before R2a (it is workspace-owned like `oauth_access_tokens`).

**Measured on the 1/20 prod-shape seed** (2,453 accounts, 472 projects, 20
legacy accounts with 69 active projects, plus 430,000 synthetic `credit_ledger`
rows = 8.6M / 20, 275 MB), run on a database at the `origin/dev` migration
level, local PostgreSQL 17.6:

| Migration | 1/20 | Prod estimate (×20) |
|---|---|---|
| M1, M1b, M4, M5a–c, M7 (each `.sql`) | 1–11 ms | the 3 s lock wait bounds each |
| M2 mark and name | 24 ms | ~0.5 s |
| M6 reconcile | 3.19 s | ~64 s |
| M8 fill | 15.91 s | ~5.3 min (`credit_ledger` dominates; ~4.5 GB of new row versions) |

After the run, I1–I12 report 0 violations; 3,504 ledger rows of the 20
legacy accounts stay NULL (`split_pending`). A writer holding a row lock on
`credit_ledger` makes the M7 file wait 3 s, fail with 55P03 and roll back (no
column, no trigger); the rerun after the holder commits takes 49 ms. The
`origin/dev` API run against the migrated database (create account, rename,
add member, provision + rename + list + delete a project) answers 0 errors and
leaves I1–I12 at 0.

**Added by the finisher (2026-11-06), same order rules:**

- `20261106140500000_workspaces_account_id_indexes.concurrent.ts` (before M4):
  `(account_id)` indexes, `CREATE INDEX CONCURRENTLY`, on the six expand tables
  that had none (`oauth_access_tokens`, `oauth_authorization_codes`,
  `app_runtimes`, `app_volumes`, `cli_device_grants`, `capture_device_grants`).
  The fill the reconcile runs on a new workspace's first project no longer
  sequentially scans them inside the provision transaction.
- `20261106142200000_workspace_id_api_keys.sql`: `api_keys` is hot (every
  API-key request reads it, no cache), so it left batch 2 for its own file.
- `apps/api/scripts/workspace-split.ts fill <account>... | fill --null` stamps
  the expand rows of an account that left `split_pending` outside the split
  runner (a transfer, an old pod's archive). R2a step 10a runs `fill --null`.

**Split holds (decided by the finisher, record for Marko):** an account with an
`account_sso_providers` row or a live SCIM token is held
(`held_reason: account_has_identity_provider`) whatever the keeper: the split
copies members, not the IdP, so SSO enforcement and SCIM deprovisioning would
stop at the keeper. Confirming the keeper does not release it; the split
carrying identity is a follow-up. The move transaction re-checks both holds
under the run lock. Every split-off grant is keyed by run AND target account
(`split_off_grant:<run>:<account>`), so a reopened run never replays the
dormant account's grant. The owner email waits until every done run has
`plan.billing`.

No index on the new `workspace_id` columns in R1 (nothing reads them until R2).
`mixed-version-safe` annotations: the old image never names `workspaces`, the new columns,
the functions or `person_deletion_requests`; the BEFORE triggers only set a column the old
image never reads.

### 3.4 Streams

Wave 1 runs in parallel: **identity, auth, api, runtime**. Wave 2 runs in parallel after
wave 1 is integrated: **billing, split, web**. Each stream works on a sub-branch of
`workspaces` in its own worktree and never opens a PR. The briefs below are the contract
of what each builds, proves and must not touch. Every stream obeys CLAUDE.md: no customer
data, no `--no-verify`, never `git stash`, never kill a process it did not start, no prod
or staging access, T0 + covering tests one by one + the real surface, never a whole suite;
the `sdk`, `migration`, `learnings`, `billing`, `kortix-brand` and `kortix-design-system`
skills load before their surfaces.

File ownership (a file has one owner per wave; a stream that must change another stream's
file asks the orchestrator):

| Stream | Owns |
|---|---|
| identity | `packages/db/migrations/*workspace*`, `packages/db/src/schema/kortix.ts` (workspace objects, expand columns, comments), new `packages/db/src/workspace-key-classes.ts`, `apps/api/src/workspaces/*.ts` except `index.ts` and `split/`, `apps/api/src/workspaces/split/invariants.ts` (adds I9–I12 only), `apps/api/src/projects/new-workspace.ts`, `apps/api/src/projects/lib/project-deletion.ts`, the DELETE handler in `apps/api/src/projects/routes/project-settings.ts`, the restore and setup handlers, an additive explicit-project-id option in `apps/api/src/projects/provision-core.ts` (setup only), `GET /v1/account/deletion-plan`, `apps/api/src/billing/services/account-deletion.ts`, `apps/api/src/billing/routes/account-deletion.ts`, `apps/api/src/billing/services/free-credit-claims.ts`, `apps/api/src/worker/jobs/account-deletion.ts`, `apps/api/eslint.config.mjs` + `eslint-suppressions.json`, `apps/api/scripts/workspace-invariants.ts`, `decisions.md`, `README.md` (this folder) |
| auth | `apps/api/src/iam/**`, `apps/api/src/middleware/{workspace-binding,actor,auth-scope,sso-gate,agent-scope}.ts`, `apps/api/src/accounts/request-gates.ts`, `apps/api/src/accounts/iam/**`, `apps/api/src/accounts/core/{invites,members,member-role-write,tokens,app}.ts`, `apps/api/src/accounts/invites.ts`, `apps/api/src/scim/users.ts`, `apps/api/src/projects/lib/project-access.ts`, the project access routes, `apps/api/src/shared/impersonation.ts`, `packages/shared/src/workspace-actions.ts`, `packages/manifest-schema/src/**`, `apps/api/scripts/workspace-verdict-parity.ts` |
| api | `apps/api/src/app.ts`, `apps/api/src/workspaces/index.ts` + new `apps/api/src/workspaces/routes.ts`, `apps/api/src/projects/provision-core.ts` (except identity's setup option), `apps/api/src/middleware/workspace-account.ts`, `apps/api/src/shared/route-params.ts`, `apps/api/src/projects/routes/{projects,project-detail}.ts`, `apps/api/src/projects/lib/{serializers,project-quota}.ts`, `apps/api/src/accounts/secret-resources.ts`, `apps/api/src/openapi/**`, `apps/api/scripts/dump-routes.ts`, `tests/spec/routes.generated.json`, the `WS-ROUTE` rows of `tests/spec/end-to-end.md`, `packages/shared/src/workspace-routes.ts`, new `packages/shared/src/workspace-settings.ts`, `packages/sdk/**`, `apps/web/content/docs/developers.mdx` |
| runtime | `apps/cli/**`, `apps/tui/**`, `apps/kortix-sandbox-agent-server/**`, `packages/starter/templates/**`, `apps/api/src/projects/lib/my-kortix-prompt.ts`, `packages/shared/src/host-config/**` |
| billing (wave 2) | `apps/api/src/billing/**` except identity's three files, `apps/api/src/shared/{session-costs,cost-rollups}.ts`, `apps/api/src/router/routes/usage.ts`, the SDK billing types, `apps/web/src/features/billing/**`, `packages/ui/src/internal/lib/billing/**`, the `billing.*` keys of the 9 web catalogs, `.agents/skills/billing/**`, the billing rows of `faq.md`, M9 |
| split (wave 2) | `apps/api/src/workspaces/split/**` (I1, I2, I8), `apps/api/src/projects/lib/{workspace-split-copy,project-transfer}.ts`, `apps/api/src/worker/jobs/workspace-split.ts`, `apps/api/scripts/workspace-split.ts`, `apps/api/src/llm-gateway/credentials/{codex,opencode-console}.ts`, the split owner email, `split_notice` on `GET /v1/workspaces/:id` and its SDK type, `split-runbook.md` |
| web (wave 2) | `apps/web/**` except `features/billing`, `packages/ui/**` except `internal/lib/billing`, `apps/mobile/**`, every web/ui catalog key except `billing.*`, `.agents/skills/kortix-brand/references/**` (noun table, decision entry), `ux.md`, the Playwright journeys |

### 3.5 Verification bar for Release 1

- Each stream: T0 for every package it touched; each covering test file by name; its DB
  suites one by one (`pnpm test -- --db-only <path>`); its flows one by one (`pnpm test --
  --id <ID>`); its real surface (curl against the worktree stack, the real CLI process,
  agent-browser with network assertions). Every behavior removed or changed is proven at
  the boundary users touch with real input and output.
- Integration (orchestrator, after each wave): the verdict-parity run (every route × 7
  credential kinds × 8 roles, base `origin/dev` vs head) with every difference classified
  intended and listed in the PR; the mixed-version run (`origin/dev` API against the
  migrated DB); the split dry-run → apply → invariants → reverse → reopen → apply on the
  prod-shape seed; one real Platinum session in a new workspace where the agent runs
  `kortix access invite` (K1) and answers in workspace vocabulary.
- The PR (create-pr skill): demo video of create → invite → join → Settings panel → delete →
  restore; the verification table; the parity diff summary; the risks below.

### 3.6 Risks and open points for Marko

1. **Agents gain workspace administration.** With K1 and C8, a governed agent granted `"*"`
   (the canonical form since #11853) can now manage members, roles, groups, policies and the
   MFA/SSO/session policy, and an inherited agent (My Kortix) can do all the person can,
   except `HUMAN_ONLY`. That is the "agent either can or cannot" model. An admin narrows an
   agent by binding a role to its service account. Announce it in the release notes. Marko
   confirms before merge; the alternative (default ceiling without administration writes)
   is one constant.
2. **The split moves customer data** (633 moves on prod). Ships in `dry_run`; `apply` is a
   separate approved step; every run is reversible; the comp credits total is in the
   dry-run report before `apply`.
3. **Comp credits are money.** K4's pro-rated plan credits for paid split-offs cost at most
   one partial period for the moved projects of the 91 paying legacy accounts; the exact
   total is a dry-run aggregate.
4. **Delete becomes restorable for 14 days.** The repo deletion moves from the DELETE
   request to the sweep. The DELETE description and the web copy change ("You can restore
   it for 14 days").
5. **M8 duration.** The `workspace_id` fill runs in the deploy's migrate job: ~5.3 min on
   prod by the 1/20 measurement (§3.3), holding the migration advisory lock and leaving
   ~4.5 GB of dead `credit_ledger` row versions for autovacuum. The Promote must budget it.
6. **Legacy `DELETE /v1/projects/:id` on a 1:1 workspace now closes the account** (K2).
   Old clients get the same 200 shape.

---

## 4. Release 2: `kortix.workspaces` is the source of truth

Gate: §2. Two deploys, because rewiring writers and turning their table into a view must
be two releases (learning `2026-08-19T182307Z`), and `ON CONFLICT (cols)` cannot run
against a view (learning `2026-08-19T163833Z`).

**R2a (deploy 1, safe with R1 pods running):**

1. `CREATE UNIQUE INDEX CONCURRENTLY uq_workspaces_legacy_account ON kortix.workspaces
   (legacy_account_id)` (`.concurrent.ts`, 180 s lock floor). Valid only because the gate
   holds 0 `split_pending` rows.
2. The store writes `kortix.workspaces` first, inside one transaction, and a new
   `workspaces_mirror` trigger (AFTER INSERT/UPDATE/DELETE on `workspaces`) writes the
   `accounts` and `projects` rows. The R1 reconcile triggers stay so an R1 pod's writes to
   `accounts`/`projects` still reach `workspaces`. Loop guard: each trigger sets
   `SET LOCAL kortix.ws_sync = 'mirror'|'reconcile'` and returns at once when it sees the
   other value; `pg_trigger_depth()` is the second guard.
3. Every writer of `accounts`/`projects` goes through the store (the lint ratchet at 0 is
   the gate). Grep every `onConflictDoUpdate` / `ON CONFLICT (` on both tables; each one
   moves to the store and targets `workspaces`.
4. Twin foreign keys, `NOT VALID`: each FK into `projects(project_id)` (72 tables in
   `kortix.ts`) gets a twin into `workspaces(workspace_id)`; each FK into
   `accounts(account_id)` (50 tables) gets a twin into `workspaces(legacy_account_id)`.
   Same `ON DELETE` action. Tombstones cascade through
   `former_account_id → workspaces(legacy_account_id) ON DELETE CASCADE`.
5. `VALIDATE CONSTRAINT` for each twin, one migration per large table (SHARE UPDATE
   EXCLUSIVE, does not block writes; partitions one by one).
6. Fill the account-wide NULL `project_id` rows of the workspace-owned tables classified
   `workspace_owned_nullable` in `workspace-key-classes.ts` (for example
   `account_secret_resources` with `project_id IS NULL`, `account_model_preferences`
   `scope='account'`) with the workspace id, batched. Rows where NULL means "the person"
   (personal keys in `account_tokens`) and ledger rows keep NULL.
7. The engine accepts `scope_type = 'workspace'` and `workspace.*` strings as stored values
   (code only; no rewrite while R1 pods run).
8. Flip the shadow reads: the table is primary, `workspaces_expected` is the shadow.
9. The Drizzle property codemod (`scripts/codemods/workspace-drizzle-properties.ts
   --project-id`): `projectId → workspaceId` properties on every table, column names
   unchanged, `KORTIX_SQL_TRACE` diff empty.

10a. Before R2a ships, re-measure prod read-only (Marko approves the read): I9
     and I10 at 0 for 7 days, the count of NULL `workspace_id` per expand table
     (run `workspace-split.ts fill --null` until it reports 0 accounts), 0 accounts
     held for `account_has_identity_provider` (the split must carry SSO/SCIM first),
     and classify `oauth_refresh_tokens` (§6.2). The store flip (step 8) is one
     change in `apps/api/src/workspaces/store.ts` (`livePairs`: answer from
     `s.j`, compare `e.j`); the metric and log keep their names.

**R2b (deploy 2, after the last R2a task is up and no R1 task runs; migrations run first):**

10. Drop the R1 reconcile triggers on `projects`, `accounts`, `account_deletion_requests`
    and the R1 dual-write `BEFORE` triggers' account→workspace direction: the expand
    tables' trigger becomes `NEW.account_id := (SELECT legacy_account_id FROM workspaces
    WHERE workspace_id = NEW.workspace_id)`. `mixed-version-safe`: R2a pods write through
    the store only.
11. Rewrite `role_assignments` to `scope_type = 'workspace'`, `scope_id = workspace_id`, and
    `permissions`/`role_permissions` strings to the `workspace.*` names (small tables,
    batched `.concurrent.ts`). R2a pods read both.
11a. Drop `kortix.workspaces_expected`, `kortix.workspaces_reconcile_account` and
     the M5 trigger functions with their triggers (step 10 removes the callers);
     `kortix.workspace_id_of_account` stays as the lookup the expand tables'
     reverse trigger and the legacy routes read.
12. The compatibility views, in one transaction (`lock_timeout '3s'`):
    `ALTER TABLE kortix.accounts RENAME TO accounts_store; ALTER TABLE kortix.projects
    RENAME TO projects_store;` then `CREATE VIEW kortix.accounts` (one row per
    `legacy_account_id`, the account columns) and `CREATE VIEW kortix.projects` (one row per
    row with a config repo, tombstones included as `status = 'archived'`, `account_id =
    COALESCE(legacy_account_id, former_account_id)`), both `security_invoker`, read-only.
    The renamed stores keep their OIDs, so the old foreign keys keep enforcing; the mirror
    trigger now writes `accounts_store`/`projects_store` (`CREATE OR REPLACE FUNCTION` in
    the same transaction).
13. Gate for R3: 7 days with 0 mismatches between `workspaces` and the two stores, and the
    count check of learning `2026-11-04T182718Z` (every account and every project row of
    the stores is represented in `workspaces`).

---

## 5. Release 3: rename and drop (planned cutover, ~2 min)

1. Announce the window. Build the R3 image from code that names only the new columns
   (`uuid('workspace_id')`) and runs its full release suite against a database migrated to
   the R3 schema. Rehearse steps 2–6 on a restored snapshot (Marko approves the restore).
2. Scale the API and worker services to 0. The window lasts until the LAST old task has
   STOPPED (learning `2026-11-05T190925Z`), not until the deploy job ends.
3. Run the R3 migrations (each its own transaction, `lock_timeout '10s'`, no traffic):
   1. Drop the old FKs into `accounts_store`/`projects_store` (the twins are validated).
   2. Drop the mirror trigger. Count check inside the migration: abort when any store row
      is missing from `workspaces`. Drop `accounts_store` and `projects_store`.
   3. `ALTER TABLE … RENAME COLUMN project_id TO workspace_id` on the 132 relations (84
      that carried both keys + 48 project-only; partitions follow their parent). Indexes
      and constraints follow by attnum. Replace every plpgsql function and trigger that
      names `project_id` (`CREATE OR REPLACE`), and redefine the views (the
      `accounts`/`projects` compatibility views keep `project_id` and `account_id` as
      output column names).
   4. `account_id`: DROP it from every table classified `workspace_owned` (the both-key
      workspace-owned tables and the 44 R1 expand tables); RENAME it to `legacy_account_id`
      on the tables classified `ledger` (§1.2). Both are catalog-only; indexes on a dropped
      column drop with it.
   5. Rename the `account_*` tables to `workspace_*` (`account_memberships →
      workspace_memberships`, `account_invitations`, `account_groups`,
      `account_sso_providers`, `account_sso_group_mappings`, `account_scim_users`,
      `account_session_activity`, `account_secret_grants`, `account_secret_resources`,
      `account_model_preferences`, `account_tokens`, `account_github_*`,
      `account_deletion_requests`). Catalog-only. No views under the old table names.
4. Start the R3 image. `/health` serves the R3 SHA on every surface. Run the deployed smoke
   flows. List the lifecycle commands dead-lettered with an undefined-column error during
   the window and re-drive them.
5. Rollback: there is none by image (an older image names dropped columns). Forward-fix
   only, which is why step 1 rehearses the cutover.

---

## 6. Measured facts and table classification

### 6.1 Prod, read-only aggregates (2026-11-06)

| Measure | Count |
|---|---|
| Legacy accounts (2+ active projects) | 401, holding 1,034 active projects; 633 would move |
| … with ≤ 1 member | 390 of 401 |
| … actually paying (paid tier or purchased credits) | 91; 276 of their projects move |
| … with a stale `stripe_subscription_id` on Free | 149 |
| One-project accounts | 8,069 |
| Accounts with no active project | 40,639; 224 on a paid tier; 27,706 with a credit balance |
| Archived projects | 383, in 194 accounts |
| Relations carrying both keys | 84 (512 GB; `audit_events` ~400 GB) |
| Relations carrying only `account_id` | 77 (5.5 GB; `credit_ledger` 4.5 GB) |
| Relations carrying only `project_id` | 48 (1 GB) |

The relation counts include partitions. `packages/db/src/schema/kortix.ts` (2026-11-06)
declares 231 tables: 59 with both keys, 58 with `account_id` only, 46 with `project_id`
only, 68 with neither.

### 6.2 Classification (`packages/db/src/workspace-key-classes.ts`, identity, with a test that fails on an unclassified table)

- **R1 expand set (44)** — `account_id` only, gains `workspace_id`: `account_deletion_requests`,
  `account_github_installation_states`, `account_github_installations`,
  `account_github_user_tokens`, `account_groups`, `account_invitations`,
  `account_memberships`, `account_scim_users`, `account_secret_grants`,
  `account_session_activity`, `account_sso_group_mappings`, `account_sso_providers`,
  `api_keys`, `app_runtimes`, `app_site_blobs`, `app_site_files`, `app_volumes`,
  `audit_reconciliation_state`, `audit_webhooks`, `billing_customers`,
  `capture_device_grants`, `capture_devices`, `capture_enrollment_tokens`,
  `capture_enrollments`, `capture_workspaces`, `claude_subscription_logins`,
  `cli_device_grants`, `credit_accounts`, `credit_ledger`, `credit_purchases`,
  `credit_usage`, `enterprise_contracts`, `oauth_access_tokens`,
  `oauth_authorization_codes`, `oauth_clients`, `provider_events`, `roles`,
  `sandbox_compute_sessions`, `scim_tokens`, `timeline_actions`, `timeline_audio`,
  `timeline_chunks`, `timeline_frames`, `yolo_member_tokens`.
- **Excluded from the expand (14)** — `accounts` (becomes `workspaces`); person-keyed
  `platform_user_roles`, `feedback`, `chrome_connections`, `free_credit_claims`; records that
  outlive the workspace `workspace_name_backups`, `retention_erasures`; mixed person/
  workspace namespace `tunnel_connections`, `tunnel_permissions`,
  `tunnel_permission_requests`, `tunnel_rpc_forwards` (their own design in R2); legacy
  `sandboxes`; unused `account_subscription_ends`; `role_assignments` (normalized in R2b).
- **Both keys**: `workspace_owned` (the 45 moved tables of `PROJECT_TRANSFER_TABLES`,
  `session_pending_permissions` included), `workspace_owned_nullable` (the
  nullable-`project_id` tables whose NULL means account-wide), `ledger` (§1.2).
- Relations outside `kortix.ts` (legacy `public`/`basejump`) are out of scope. The R2
  runbook re-measures prod read-only before R2a (Marko approves the read).

---

## 7. Carried forward from the 2026-11-05 design

These parts of the earlier design stay valid and are built or kept as written there:

- Route aliases: `aliasApp` mounts the same handlers under both names; one unit test proves
  each alias pair dispatches the same handler; the route manifest carries `aliasOf`; a flow
  codemod moved `meta.routes` to canonical names, and one black-box flow per alias family
  keeps calling the old paths.
- The split engine (`project-transfer.ts` + `workspace-split-copy.ts`), its lease ledger
  (`workspace_split_runs`), its mode switch (`WORKSPACE_SPLIT_MODE` or the
  `workspace_split` row of `kortix.platform_settings`), holds for paying accounts, reverse
  and reopen: `split-runbook.md`.
- The codemods are committed, re-runnable scripts (`scripts/codemods/`); after a dev merge,
  re-run them instead of resolving their conflicts by hand.
- The verdict-parity harness (`apps/api/scripts/workspace-verdict-parity.ts`), the
  synthetic prod-shape seed (`apps/api/scripts/seed-prod-shape.ts`) and the invariant
  checker (`apps/api/scripts/workspace-invariants.ts`).
- Invariants I1–I8 (`apps/api/src/workspaces/split/invariants.ts`), extended in R1:
  I1 reverse check (finding 27), I2 for `scope_key` rows (finding 7), I8 on the reach rule
  (finding 6), and new I9 (`workspaces` equals `workspaces_expected` for every account),
  I10 (every expand row has `workspace_id = workspace_id_of_account`, or NULL only for a
  `split_pending` account), I11 (no two `credit_accounts` rows share a
  `stripe_subscription_id`), I12 (every account has exactly one live row, or one per active
  project while `split_pending`).
- The SDK rules: no export removed or renamed; `Project*`/`Account*` get `@deprecated`
  ("Kept permanently.") only where an exact `Workspace*` equivalent exists;
  `deprecated-exports.test.ts` holds the list.

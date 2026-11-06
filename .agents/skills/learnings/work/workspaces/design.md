---
title: Workspaces — full unification design (PR #11857)
status: approved direction (Marko 2026-11-05: "this pr should fully address it", "all compatibility & backwards comp should stay")
updated: 2026-11-05
---

# Design: one Workspace entity, end to end, in one release (branch `workspaces`, PR #11857)

## 0. Decision first: how workspace identity is stored (Marko's two new constraints change the earlier physical plan)

**Recommendation: keep workspace_id = `project_id` everywhere public. Keep `account_id` as the workspace's internal billing and directory key. Enforce a permanent 1:1 between the two. Rewrite no id values, rename no columns, add no compatibility views.** The old names `projects`, `accounts`, `project_id` and `account_id` stay as the physical names. That is the permanent compatibility layer, and it costs nothing.

This keeps the `workspace_id = project_id` default. It **reverses three items in the original brief**:
1. No rename of `project_id` to `workspace_id`.
2. No dropping of the redundant `account_id`.
3. No new `workspace_id` column on the account-only tables.

Why:

| Option | Cost, measured | Verdict |
|---|---|---|
| A. Physical rename `project_id→workspace_id` in 102 tables, plus a view under the old name | Permanent compatibility means every renamed relation needs a permanent view under its old name. That is about 205 prod relations including the audit partitions. Old pods running during the rollout hit `42P10` on any `ON CONFLICT (cols)` writer against a view (learning `2026-08-19T163833Z-on-conflict-…`). Rewiring the writers and swapping in the view must be two releases (`2026-08-19T182307Z-rewiring-writers-…`). The #11848 rename in one release took prod down for 17 min (`2026-11-05T190925Z`). | Reject |
| A′. Add a `workspace_id` column to the 58 account-only tables | Means rewriting `credit_ledger` 8.6M rows / 4.5 GB, `credit_accounts` 323k, `billing_customers` 232k, … and dual-writing every new row forever. Generated columns don't help: PG15 only has STORED ones (full rewrite under ACCESS EXCLUSIVE); virtual ones arrive in PG18. | Reject |
| B. workspace_id = `account_id` | Rewrites the 46 project-only tables (`project_trigger_executions` 324k / 881 MB, …). Re-keys 508 routes with `:projectId`, git remotes `/v1/git/:projectId`, the OIDC issuers `/v1/projects/:projectId/.well-known`, 7 externally registered webhook URLs, and `KORTIX_PROJECT_ID` (229 files) in running sandboxes. It is also ambiguous for the 401 legacy accounts until they are split. | Reject |
| **C. Two physical keys, one entity, enforced 1:1** | Rewrites no id values. The only new physical objects are 1 view, 1 boolean column, 1 partial unique index and 2 small tables. | **Recommend** |

I also considered giving every *new* workspace `account_id := project_id`, so the two ids become equal over time. **I reject this.** With the ids always distinct, any mix-up of account id and workspace id fails in every test. With equal ids, it would only fail on the 8,456 legacy workspaces.

"Unify the data" then concretely means:
- 1:1 enforced by a unique index.
- The 401 legacy accounts physically split.
- One name.
- One canonical `kortix.workspaces` relation.
- One IAM scope, one token fence, one id on every surface.

## 1. End-state schema

### 1.1 `kortix.workspaces` is a view, not a table
- **Why a view:** zero dual-write, it can never drift, and old pods are unaffected. A physical table would be a third copy of identity and would need triggers from both stores.
- **Definition:** `SELECT … FROM kortix.projects p JOIN kortix.accounts a USING (account_id) WHERE p.status='active'`. Declared in Drizzle as `kortixSchema.view('workspaces', …).existing()`, the same pattern as `auditEventsAll` (`packages/db/src/schema/kortix.ts:4240`). The schema contract accepts views (`packages/db/MIGRATIONS.md` "schema contract").
- **Columns from `projects`:** `project_id AS workspace_id`, `name`, `repo_url`, `default_branch`, `manifest_path`, `status`, `secret_default_strategy`, `runtime`, `metadata` (icon), `sandbox_provider_generation`, `last_opened_at`, `created_at`, `updated_at`, `split_pending` (new).
- **Columns from `accounts`:** `account_id`, `setup_complete_at`, `setup_wizard_step`, `mfa_required`, `session_max_lifetime_minutes`, `session_idle_timeout_minutes`, `pat_max_lifetime_days`, `pat_require_expiry`, `pat_idle_revoke_days`, `admins_see_all_sessions`, `automations_paused_at`, `automations_paused_by`, `branding`.
- **Not exposed:** `accounts.name`. It is mirrored from `projects.name` by a trigger.
- **Writes** go through one new repository, `apps/api/src/workspaces/store.ts`, which writes both base tables.

### 1.2 New physical objects (all additive)
- `projects.split_pending boolean NOT NULL DEFAULT false`. Adding it is a metadata-only change.
- `uq_projects_workspace_account`: `UNIQUE (account_id) WHERE status='active' AND NOT split_pending`. This is the 1:1 guarantee, and it is permanent.
- `kortix.workspace_name_backups(account_id pk, old_name, new_name, backfilled_at)`.
- `kortix.workspace_split_runs`: the split ledger. Columns: `project_id`, `from_account_id`, `to_account_id`, `phase`, `heartbeat_at`, `copied_ids jsonb`, `error`. It follows the lease pattern of `legacy_sandbox_migrations` (`kortix.ts:3533-3550`).
- Triggers `projects_name_sync` and `accounts_name_sync`: AFTER UPDATE OF name. They mirror the name only when the account has exactly 1 active project, guarded by `pg_trigger_depth() < 2`.

### 1.3 Every id-bearing relation: measured by parsing `kortix.ts`

Totals: 228 tables and 7 views. 56 tables have both ids (counting `audit_events`, which is built by `auditEventColumns()`). 58 have `account_id` only, 46 have `project_id` only, 68 have neither. In `public.ts`, `public.api_keys` has `account_id` only.

**No table gets a physical change.** The treatment column below is what the split and the code do with each table.

| Group | Count | Tables | End state / split treatment |
|---|---|---|---|
| **Both ids, workspace-owned (moved)** | 45 | the 44 in `PROJECT_TRANSFER_TABLES` (`project-transfer.ts:89-138`) + `session_pending_permissions` (unclassified today) | `project_id` is the workspace key. `account_id` stays a denormalized tenant key that must equal the bijection (invariant I2). Moved by the split. |
| **Both ids, ledgers and history (left)** | 11 | `usage_events` 3.8M, `gateway_request_logs` 3.7M/48 GB, `storage_charges`, `audit_events` (138M legacy + partitions, ~400 GB), `tunnel_audit_logs`, `tunnel_device_auth_requests`, `claude_subscription_login_flows`, `notifications`, `legacy_sandbox_migrations`, `suna_account_migrations`, + `audit_activity_daily` (unclassified; classify as left and recomputed by the `worker/jobs/audit-activity.ts` rollup) | `account_id` here means "who paid / where it happened". It is **not redundant** and is never rewritten. This is why the big tables are untouched. |
| **Project only** | 46 | `project_snapshot_archives`, `config_releases`, `config_release_heads`, `project_config_summaries`, `base_tip_checks`, `config_release_failures`, `project_secrets`, `project_secret_tombstones`, `project_secret_requests`, `project_space_links`, `project_user_marks`, `project_session_secret_handles`, `project_llm_routing_policies`, `project_trigger_runtime`, `project_trigger_session_access_grants`, `project_monitor_events`, `project_trigger_executions` 324k, `chat_installs`, `chat_channel_bindings`, `chat_threads`, `chat_pending_auth_messages`, `chat_turn_streams`, `voice_call_turns`, `voice_call_read_cursors`, `voice_join_links`, `teams_pending_uploads`, `gateway_budgets`, `gateway_spend_daily`, `gateway_otel_configs`, `project_signing_keys`, `connector_project_policies`, `connector_project_settings`, `connector_sync_fences`, `session_tool_approvals`, `project_user_provider_connections`, `drive_grants`, `notification_watchers`, `trigger_watchers`, `room_members`, `session_peer_messages`, `session_tasks`, `chrome_grants`, `chrome_attachments`, `artifact_comment_threads`, `artifact_comment_screenshot_objects`, `artifact_events` | Already keyed by workspace. They move implicitly with the project. |
| **Account only: directory and IAM** | 14 | `accounts`, `account_memberships`, `account_invitations`, `account_groups`, `roles`, `role_assignments`, `account_scim_users`, `scim_tokens`, `account_sso_providers`, `account_sso_group_mappings`, `account_session_activity`, `account_secret_grants`, `audit_webhooks`, `audit_reconciliation_state` | Workspace settings, resolved through the bijection. Split: **copy** into the new account (groups, custom roles and grants remapped; today the transfer **deletes** them, `project-transfer.ts:294-298`). |
| **Account only: money** | 10 | `billing_customers` 232k, `enterprise_contracts`, `credit_accounts` 323k, `credit_ledger` 8.6M, `credit_usage`, `credit_purchases`, `free_credit_claims`, `account_subscription_ends`, `provider_events`, `sandbox_compute_sessions` | Stay with the account that keeps the most recently opened project. Never copied. Split-off accounts start on Free with no Stripe customer. |
| **Account only: integrations and credentials** | 11 (+`public.api_keys`) | `account_github_installations`, `account_github_installation_states`, `account_github_user_tokens`, `claude_subscription_logins`, `oauth_clients`, `oauth_authorization_codes`, `oauth_access_tokens`, `oauth_refresh_tokens`, `cli_device_grants`, `yolo_member_tokens`, `api_keys` | GitHub installations and Claude logins are copied, and the Claude logins are re-encrypted. OAuth clients and tokens stay with the keeper, and their owners are notified (see risk 1). |
| **Account only: app hosting** | 4 | `app_site_files`, `app_site_blobs`, `app_volumes`, `app_runtimes` | **Must move**, joined by `app_id → apps.project_id`. This is the live bug in faq.md "split" item 2. |
| **Account only: Capture** | 9 | `capture_workspaces`, `capture_device_grants`, `capture_devices`, `capture_enrollment_tokens`, `capture_enrollments`, `timeline_chunks`, `timeline_frames`, `timeline_actions`, `timeline_audio` | Stay with the keeper (faq.md Capture). |
| **Account only: tunnel and computers** | 4 | `tunnel_connections`, `tunnel_rpc_forwards`, `tunnel_permissions`, `tunnel_permission_requests` | Private machines stay in the person's namespace. Shared machines stay with the keeper. |
| **Account only: person or platform keyed** | 3 | `platform_user_roles` (its `account_id` holds the user id), `feedback`, `chrome_connections` | Not workspace data. No change. |
| **Account only: lifecycle and ops** | 3 | `account_deletion_requests`, `retention_erasures`, `sandboxes` (legacy) | Stay with the keeper. |
| **Views** | 7 | `project_members`, `project_group_grants`, `iam_resource_grants`, `audit_events_all` (both ids); `account_members`, `iam_policies` (account only); + 1 with neither | Existing RBAC compat views (`migrations-pending/README.md`). Unchanged. |

The only name collisions are TypeScript-only changes; the columns stay:
- `workspace_id` in 6 chat tables means the Slack/Teams team id: `chat_installs`, `chat_channel_bindings`, `chat_threads`, `chat_pending_auth_messages`, `chat_thread_participants`, `chat_user_identities` (`kortix.ts:2434-2594`; 240 non-test API references). Their Drizzle property becomes `platformTeamId`.
- The Drizzle symbol `captureWorkspaces` becomes `captureTenants`.

### 1.4 Dormant accounts (40,618 with 0 projects)

What is keyed to them:
- `credit_accounts`. Its 323k rows against 49,068 accounts means about 274k rows have no live account. **Measure this before writing any code.**
- `billing_customers` (232k).
- Owner rows in `account_memberships` and account-scope `role_assignments`.
- `account_tokens` and `api_keys` minted on personal accounts.
- `free_credit_claims` (34,980 accounts hold a grant, faq.md).

What happens to them:
- Kept untouched as dormant records. No workspace row, never listed.
- Their tokens pass the fence only on routes that need no workspace (§5).
- "Create workspace" reuses the newest empty account the person owns (ux.md §1), which turns that account and its credits into a workspace.
- Nothing is deleted in this PR.

## 2. Migration sequence (one release; old pods keep working throughout)

Deploys run migrations before the ECS roll (`deploy-prod.yml:1221-1251`). The migrate job has **only `DATABASE_URL`**. Everything below is additive, so rolling back to the previous image stays safe (`kortix-rollback` SKILL §4).

| # | File | Statements | Lock / size | Old code | Rollback |
|---|---|---|---|---|---|
| M1 | `…_workspaces_expand.sql` | `ALTER TABLE projects ADD COLUMN split_pending boolean NOT NULL DEFAULT false`; `CREATE VIEW kortix.workspaces`; create the 2 small tables; 2 name-sync functions and triggers | Brief ACCESS EXCLUSIVE on `projects` (~9.5k rows, but hot-read) and SHARE ROW EXCLUSIVE on `accounts`. `lock_timeout='3s'`; retry on 55P03. Needs a `mixed-version-safe:` annotation stating that old code never names these objects. | Ignores them | Leave in place. Forward-fix with `DROP TRIGGER` in a new migration. |
| M2 | `…_workspaces_mark_and_name.concurrent.ts` | (a) mark `split_pending=true` on the active projects of accounts with 2+ active (1,034 rows, one statement); (b) write old names to `workspace_name_backups`, then `UPDATE accounts SET name=p.name` for the 8,055 1:1 accounts, in batches of 1,000, `WHERE name IS DISTINCT FROM`. It must be `.concurrent.ts` because the backfill guard forbids DML in `.sql` (2026-08-10 outage). | Row locks only, ~9k rows | Unaffected; it only sees the new names | In one transaction: `ALTER TABLE accounts DISABLE TRIGGER accounts_name_sync`, `UPDATE accounts a SET name=b.old_name FROM workspace_name_backups b …`, `ENABLE TRIGGER`. Without the disable, the M1 trigger renames each 1:1 project to the old account name (the full statement is in the M2 header). |
| M3 | `…_workspaces_one_per_account.concurrent.ts` | TS loop (≤3 tries): re-mark any account that gained a second active project since M2, then `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_projects_workspace_account …`. On a 23505 or an INVALID index: `DROP INDEX CONCURRENTLY`, re-mark, retry. `lock_timeout='180s'` (lint floor ≥120 s), `statement_timeout='30min'`. | ShareUpdateExclusive only | An old pod creating a 2nd project in a 1:1 account now gets 23505 → 500. That is the intended 409 behavior arriving early; announce it. | `DROP INDEX CONCURRENTLY` |
| Roll | API image | New code: 409 on a second project, workspace routes, the one-scope IAM, the fence | — | — | Image rollback (additive schema) |
| S | `worker/jobs/workspace-split.ts` (leader only, per CLAUDE.md "Scheduled jobs") | Splits the 401 accounts: 633 project moves (1,034 − 401). One project per transaction through the fixed `transferProjectOwnership`. Mode is a runtime flag: `off`, `dry-run` (default), or `apply`. | Row locks on the moved project's rows. 10 moved tables have no leading `project_id` index: `account_model_preferences`, `project_trigger_event_subscriptions`, `session_idle_watches`, `session_turns`, `session_logs`, `session_content_purges`, `session_pending_questions`, `service_accounts`, `connection_oauth_sessions`, `prompt_attachments`. Run EXPLAIN in the rehearsal and add CONCURRENTLY indexes in M3 if `session_turns`/`session_logs` seq-scan. Inactive projects go first; the 25 active and 11 paying go last, in a low-traffic window. | Old pods: legacy accounts are still a valid shape | Per project: `transferProjectOwnership` back to `from_account_id`, then delete the copies listed in `workspace_split_runs.copied_ids` |

Why the split cannot be pure SQL, and why it is not a `.concurrent.ts`:
- Secrets are sealed with `HKDF(config.API_KEY_SECRET, accountId)` (`apps/api/src/secrets/account-resource.ts:13`), so moving them needs decrypt and re-encrypt. Claude logins are sealed with the account key too.
- The migrate job has no `API_KEY_SECRET`.
- `migration-runtime-overrides.ts` is only for correcting a merged migration that failed. It is not a data-migration runner.

So the split runs in the API runtime, as a resumable worker job with a lease (the `legacy_sandbox_migrations` pattern). `split_pending` exists so that M3 can ship the unique index **in this release**, before the split finishes. The worker clears the flag per project.

**Transfer engine fixes the split needs**, in `apps/api/src/projects/lib/project-transfer.ts`:
- Classify `session_pending_permissions` (move) and `audit_activity_daily` (leave).
- Move the 4 `app_*` tables by `app_id`.
- Copy groups and custom roles and remap their grants, instead of deleting them (`:294-298`).
- Copy-and-re-encrypt the account-wide `project_id IS NULL` secrets and their grants.
- Add memberships for everyone holding a grant, and re-add owners and admins.
- Split invites whose `bootstrap_grants` span several projects.
- Copy GitHub installations and Claude logins.
- Add a bypass for the target-limit check, since a new account is on Free with limit 1 (`:283`).

The classification test in `project-transfer.integration.test.ts` must cover all 56 both-id tables.

## 3. Drizzle and code

- **Usage counts in `apps/api/src`:**
  - `projectId` 16,710 (11,396 outside tests) in 1,410 files; `accountId` 12,692 (7,753) in 1,302 files.
  - `.projectId` member accesses 4,460; `.accountId` 3,660.
  - `projects.<col>` 909; `accounts.<col>` 416.
  - `param('projectId')` 308; `param('accountId')` 121; `'/:projectId'` route literals 491.
- `@kortix/db` is private and only `apps/api` imports it (1,035 files). Drizzle symbols are internal, so they need no compatibility exports.
- **Approach:** rename at the seams, not every local variable. The bulk rename is what sank #5480: 2,296 files, which fell 799 commits behind dev.
  1. Add `apps/api/src/workspaces/`: the branded types `WorkspaceId` and `WorkspaceAccountKey`, `resolveWorkspace(idOrAccountId) → {workspaceId, accountId, splitPending}`, and the store. Both ids are unique, so either one resolves.
  2. Codemod 1 (ts-morph, committed at `scripts/codemods/workspace-route-params.ts`): rename `:projectId`/`:accountId` route params to `:workspaceId`, and the `param()` reads to a `workspaceIdParam(c)` helper.
  3. Codemod 2, run last: rename the Drizzle *properties* on the 102 tables with `project_id`, `projectId` → `workspaceId` (column name unchanged), plus the chat `platformTeamId` collision.
     - tsc catches every miss.
     - `KORTIX_SQL_TRACE` diffs prove the SQL is byte-identical (CLAUDE.md "SQL trace").
     - Status 2026-11-05: `scripts/codemods/workspace-drizzle-properties.ts` landed. The collision stage ran (`captureTenants`, chat `platformTeamId`); its SQL-trace diff over 10 flows and the chat and capture DB suites was empty. The `projectId` stage is behind `--project-id`: on 113 tables it rewrote 608 files and left 1,551 tsc errors, ~315 of them hand-written row mirrors (`GitBackedProject`, `ArtifactScope`, `Pick<…, 'projectId'>`). Move it one module at a time under the ratchet.
  4. A ratchet test: the count of `projectId` in `apps/api/src` can only go down.
- **Keeping the diff reviewable:** every codemod is a committed, re-runnable script. After each dev merge, re-run the script instead of resolving conflicts by hand. Each codemod lands as its own commit with no behavior change in it.

## 4. API

- **Route counts** (`tests/spec/routes.generated.json`, 1,040 routes):
  - 508 contain `:projectId`: 460 `/v1/projects`, 41 `/v1/connectors/projects`, 7 `/v1/webhooks`.
  - 147 contain `:accountId`: 130 `/v1/accounts`, 17 `/scim/v2`.
  - Ambient-account routes: `/v1/billing` 44, `/v1/usage` 5, `/v1/account` 4.
- **Aliases:** mount the same sub-app twice in `app.ts`. `app.route('/v1/workspaces', projectsApp)` is canonical, and `/v1/projects` stays mounted permanently right after it (CLAUDE.md "Routes register explicitly; call order is dispatch order").
- **Account routes collapse** into `/v1/workspaces/:workspaceId/{iam(68),capture(23),audit(10),secret-resources(9),branding(5),members(4),invites(3),automations(2),subscription-connections(2),top-up-requests,leave}`. A middleware resolves workspace → `accountId` for the existing handlers.
  - The only subtree that collides is `/audit`: account audit has 10 routes, project audit has `GET /audit`. Merge them into one handler: events where `project_id = ws`, or where `project_id IS NULL AND account_id = ws.account`.
  - `GET/PATCH /v1/accounts/:accountId` merge into `GET/PATCH /v1/workspaces/:workspaceId`.
- **Old routes are permanent.** Responses add `workspace_id` next to `project_id` and `account_id`. Requests accept either id: `?account_id=` also accepts a workspace id through `resolveScopedAccountId` (`middleware/resolve-account.ts`).
- **Routes with no workspace:**
  - `GET/POST /v1/accounts` → `GET/POST /v1/workspaces` (list/create)
  - `/v1/accounts/me` (3) → alias `/v1/me`
  - `/v1/account-invites` (4): a person accepting an invite → alias `/v1/invites`
  - `/v1/accounts/tokens` (3) → `/v1/workspaces/:id/tokens`; the old path resolves ambiently
  - Global: billing webhooks, cron and tier-configurations; `/v1/admin`, `/v1/platform`, `/v1/skills`, `/v1/runtime-assets`, `/v1/feedback`, health
  - `/v1/webhooks/*/:projectId` (7) and `/scim/v2/:accountId` (17) are URLs registered in external systems. Keep them; add `/scim/v2/workspaces/:workspaceId`.
- **Manifest and flows:**
  - About 655 alias rows are added (1,040 → ~1,695), each carrying `aliasOf`.
  - `tests/src/coverage/check-coverage.ts` counts an alias as covered when its canonical route is covered (the baseline is 0 uncovered).
  - One unit test asserts that each alias pair dispatches the same handler in `app.routes`.
  - A codemod moves the flows' `meta.routes` and calls to canonical paths: 1,265 `/v1/projects` and 587 `/v1/accounts` strings in 98 flows. One black-box flow per alias family keeps calling the old paths.
  - The SDK's `route-contract.test.ts` keeps both families honest.

## 5. IAM: one workspace scope

- **Storage stays permanently.** `role_assignments.scope_type` stays `account|project` (`kortix.ts:6624-6629`). Rewriting it to `workspace` would break old pods during the rollout, and its writers use upserts (the two-release rule).
- **The engine normalizes.** `Obj` becomes `{type:'workspace', id, resource?}` (`iam/authorize.ts:75-77`). An assignment reaches workspace W when:
  - `scope_type='project' AND scope_id=W`, or
  - `scope_type='account' AND account_id=W.account`.

  For 1:1 workspaces that is exactly today's semantics. For `split_pending` legacy accounts, an account-scope grant still reaches every project: README Target item 4, kept as a permanently supported state.
- **Roles:** the workspace has owner, admin, manager and member. Account and project `member` are both "member"; project `manager` stays distinct (`iam/roles.ts:18-19`).
- **Actions:** 31 account and 54 project actions (`iam/actions.ts`) get a **1:1 rename** to `workspace.*`, with no merges, so parity holds by construction. For example: `project.read→workspace.read`, `account.write→workspace.settings.write`, `billing.read→workspace.billing.read`, `project.session.start→workspace.session.start`. `project.create` becomes a person-level capability.
  - Stored action ids in `permissions` and `role_permissions` stay the legacy strings, which old pods still check.
  - One bidirectional alias map lives in `packages/shared`. The API, `packages/manifest-schema/src/constants.ts` and the SDK `iam-actions.ts` all import it (learning 2026-10-03: one parser). The wire emits `workspace.*` and accepts both forever.
- **The fence becomes one rule:** `credential.workspace == binding(route).workspace`. This replaces the 9 special cases in `enforceTokenProjectScope` (`middleware/auth-scope.ts:75-222`).
  - New file `middleware/workspace-binding.ts` gives each route one of 4 binding kinds: `path` (`:workspaceId|:projectId|:accountId` via the bijection), `resource` (session, drive, sandbox `/v1/p/:id`, artifact → workspace), `ambient` (`?account_id`, or the credential's own workspace), or `none` (an explicit list: `/v1/me`, skills, runtime-assets, feedback, health).
  - A unit test fails if any manifest route lacks a binding, so an unlisted route fails in CI instead of answering 403 at runtime.
  - Account-wide tokens bind to their account's workspace. Tokens on dormant accounts bind to none.
  - Agents (`agent_session` actors) never inherit workspace administration. That ceiling is enforced in `authorize`, not in the fence.
- **Proving parity** (`apps/api/scripts/workspace-verdict-parity.ts`, the same shape as `rbac-cutover-audit.ts`):
  - Seed one database with both 1:1 and split-pending accounts.
  - Run every route (1,040 + aliases) × 7 credential kinds (JWT, account PAT, project PAT, session PAT, service account, API key, OAuth) × 8 roles (owner, admin, member, manager, project member, no grant, group grant, custom role), in process through `app.request`. That is about 116k requests.
  - Run it against the base commit's worktree and against the new head. Compare the auth verdict (401/403 + `check=` reason) against everything else.
  - Every difference is listed, and Marko approves it before merge. The expected differences are the fence cases that are now intended.

## 6. SDK (`@kortix/sdk`, published)

- **Surface today** (snapshots): runtime names 2,306, of which 271 contain `Project`, 85 `Account`, 16 `Workspace`. Type names 4,251, of which 485 `Project`, 152 `Account`, 24 `Workspace`.
- **Collision:** `Workspace*` already means the sandbox file tree: `RuntimeWorkspace*`, the `./workspace-search` subpath, `toWorkspaceRelative`, `core/files`. Keep those and document them in the glossary. New entity names must not reuse them.
- **Add, test-first** per the `sdk` skill (snapshot diff reviewed; three synchronized edits per new subpath): `Workspace`, `WorkspaceSummary`, `WorkspaceRole`, `listWorkspaces`, `getWorkspace`, `updateWorkspace`, `kortix.workspace(id)`, `useWorkspaces`, `useWorkspace`, workspace IAM/members/billing/tokens clients, and `workspace_id` on response types. `createWorkspace` already exists (`core/rest/projects-client/projects.ts:1073`).
- **Deprecate:** `Project*` and `Account*` get `@deprecated` **only where a Workspace equivalent exists**, and nothing is removed.
- **Docs to update:** the `sdk` skill's template text "Removed in the next major" (SKILL.md:211) must become "kept permanently". Update `deprecated-exports.test.ts` to match.

## 7. Risks, verification, effort

### Risks, ranked
1. **The split corrupts or loses data** (633 moves, re-encryption, tokens). Account-wide tokens, OAuth clients and API keys stay with the keeper, so their holders lose access to moved projects. Before enabling the split, count the affected tokens (aggregates only) and notify their owners.
2. **IAM or fence regression**, either escalation or lockout. The parity table covers this.
3. **M3 index build race blocks the deploy.** Covered by the re-mark/retry loop and the INVALID-index runbook in MIGRATIONS.md.
4. **ACCESS EXCLUSIVE on hot `projects` in M1.** Covered by a 3 s lock_timeout and retry.
5. **Merge drift and PR size.** The branch is already 699 files, +59,899/−23,881 against dev. Covered by sub-branches and re-runnable codemods.
6. **Hidden mix-ups of account id and workspace id.** Covered by branded types and distinct-id fixtures.
7. **The name backfill visibly renames 8,055 accounts.** The backup table makes it reversible.

### Verification
- **Invariant checker** `apps/api/scripts/workspace-invariants.ts` (read-only):
  - I1: 0 accounts with more than 1 active project that is not split-pending.
  - I2: on moved tables, `account_id` = `projects.account_id`.
  - I3: `probeAccountSecret` passes for every moved secret.
  - I4: every grantee has a membership.
  - I5: credit balance sum and Stripe customers per account are unchanged; split-off accounts have 0.
  - I6: names equal for 1:1 workspaces.
  - I7: grant counts per (principal, workspace) are unchanged.
  - I8: every member the split added to a new workspace holds a grant on it or is an owner.
- **Mixed-version proof:** run the current prod image's API against a worktree `--db` with M1–M3 applied, then run the flow suite (learning 2026-10-28).
- **Prod-shaped data:** the worktree `--db` only copies the young local DB, which is not enough.
  - (a) A synthetic, PII-free seed script in `apps/api/scripts/` reproducing the measured shape: 8,055 1:1 accounts, 401 multi-project accounts with 1,034 projects (max 23), 40,618 empty accounts, 58 people in several accounts. It feeds the dry-run, the parity run and the invariants.
  - (b) Measure staging's shape.
  - (c) For timings, locks and EXPLAIN: restore an RDS snapshot inside the prod account, run M1–M3 and a split dry-run, and export aggregates only. **This needs Marko's approval.**
- **Split `dry-run` on prod first:** it writes the plan into the ledger and only aggregates are reviewed. Then switch to `apply`.

### Effort (agent-days)

| Workstream | Days | Sub-branch |
|---|---|---|
| W0 identity: M1–M3, view, `workspaces/` resolver and types | 1.5 | `ws/identity` (first, blocks the rest) |
| W1 transfer fixes + split worker + dry-run + reverse + invariants | 3.5 | `ws/split` |
| W2 routes: aliases, account collapse, binding table, manifest `aliasOf`, coverage, flow codemod | 3 | `ws/routes` |
| W3 IAM: one scope, action alias map, fence, parity harness and review | 4 | `ws/iam` |
| W4 SDK Workspace surface (TDD) + web/mobile adoption | 3 | `ws/sdk` |
| W5 CLI / kortixd `KORTIX_WORKSPACE_ID` fallback (partly done: `apps/cli/src/project-link.ts`) | 1 | with W4 |
| W6 Drizzle property codemod + SQL-trace proof | 1.5 | `ws/codemod` (last) |
| W7 seed, mixed-version run, snapshot rehearsal | 2 | `ws/verify` |
| **Total** | **~19.5 agent-days**, about 7–8 calendar days with 4 in parallel | |

**Order of work:** W0 first. Then W1, W2, W3 and W4 run in parallel: they touch mostly separate directories (`projects/lib` + `worker/jobs`; `app.ts` + `tests/spec`; `iam/` + `middleware/`; `packages/sdk` + `apps/web`). W2's param codemod lands as one early commit before W3 edits any route files. W6 runs after everything else is merged. Merge dev into each sub-branch daily.

### Critical Files for Implementation
- /work/Projects/kortix/suna-workspaces/packages/db/src/schema/kortix.ts
- /work/Projects/kortix/suna-workspaces/apps/api/src/projects/lib/project-transfer.ts
- /work/Projects/kortix/suna-workspaces/apps/api/src/iam/authorize.ts (with /work/Projects/kortix/suna-workspaces/apps/api/src/iam/actions.ts)
- /work/Projects/kortix/suna-workspaces/apps/api/src/middleware/auth-scope.ts
- /work/Projects/kortix/suna-workspaces/apps/api/src/app.ts (with /work/Projects/kortix/suna-workspaces/tests/src/coverage/check-coverage.ts)

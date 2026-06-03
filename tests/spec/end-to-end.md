# Kortix End-to-End Flows

Single source of truth for the e2e suite. Every flow the platform supports, start→finish, enumerated. Each step is `METHOD /path → expected`. CLI steps are `kortix …`. Negatives (`→ 4xx`) are part of the flow, not optional. Each flow has a stable ID (`PROJ-3`, `IAM-7`) so a test maps 1:1 to a line here.

Stack: TypeScript/Hono on Bun (`apps/api`), Drizzle→Postgres (`kortix` schema), Next.js (`apps/web`), `kortix` CLI (`apps/cli`). **No RLS** — all authz is app-layer via the IAM engine, so every assertion must go through the HTTP API. Sessions run **OpenCode** inside an ephemeral per-session sandbox reached through the preview proxy.

> **Audited** against source on branch `newer-kortix` (every route/gate/status below confirmed at `file:line`). Coverage/dead-code tooling for running this suite is §22.

---

## 0. Conventions

- `$API` = `<host>/v1` (local `http://localhost:13738/v1`, cloud `https://api.kortix.com/v1`). **Every route is `/v1`-prefixed.** Two unprefixed health routes exist (`/health`, `/v1/health`).
- `$WEB` = dashboard origin (`api.` stripped from host; localhost→`:3000`/`:13737`).
- Auth header: `Authorization: Bearer <token>`. Token types:
  - **JWT** — Supabase user JWT (humans). Verified locally via JWKS.
  - **PAT** — `kortix_pat_…` CLI personal access token (`account_tokens`). Carries real `userId`. May be **project-scoped** (`projectId` set).
  - **APIKEY** — `kortix_` / `kortix_sb_` (`api_keys`). Account/sandbox identity; `accountId→userId` mapped. Used by sandbox→router (search/LLM/proxy).
  - **COOKIE** — `__preview_session`, scoped `/v1/p/`, 1h.
- Auth middlewares: `supabaseAuth` (JWT or PAT) on `/v1/accounts/*`, `/v1/projects/*`, `/v1/platform/api-keys`. `combinedAuth` (JWT|token|PAT|cookie|`X-Kortix-Token`|`?token=`) on `/v1/p/*`, `/v1/servers/*`, `/v1/tunnel/*`, `/v1/deployments/*`. `apiKeyAuth` (kortix_ only) on `/v1/router/*`. `requireAdmin` (platform role) on `/v1/ops/*`. Webhooks = HMAC, no auth middleware.
- Project authz gate `loadProjectForUser(c, id, level)`: `read`→`PROJECT_READ` (any project role), `write`→`PROJECT_WRITE` (editor/manager), `manage`→`PROJECT_DELETE` (manager only). Account owner/admin get implicit `manager` on every project.

### Principals (fixtures every run must provision)

| Key | What | Used to assert |
|---|---|---|
| `OWNER` | account owner (super-admin, bypasses policy) | full access |
| `ADMIN` | account `admin` (Administrator policy) | all but account.delete / billing.write / owner-grant |
| `MEMBER` | account `member`, **no** project grant | account-reads only; cannot see projects |
| `M_VIEWER` `M_EDITOR` `M_MANAGER` | member + project_members row (viewer/editor/manager) | per-project read / write / manage |
| `BILLING` | `billing_manager` policy | billing read+write only |
| `AUDITOR` | `auditor` policy | reads + audit only |
| `RO_ADMIN` | `administrator_read_only` | read-only everywhere |
| `DENY_USER` | member with explicit `deny` policy on a project | deny-wins over any allow |
| `NONMEMBER` | user in a different account | 403 `not_a_member` / 404 |
| `PAT_ACCT` | account-scoped PAT minted by OWNER | inherits minter unless narrowed |
| `PAT_PROJ` | project-scoped PAT (minted per session) | hard-fenced to one project |
| `APIKEY` | `kortix_` api key | router/proxy + sandbox identity |
| `ANON` | no Authorization header | 401 on protected routes |

### System / health (public unless noted)

`SYS-1` `GET /health` · `GET /v1/health` → 200 `{status:"ok",service:"kortix-api"}`.
`SYS-2` `GET /v1/system/maintenance` → 200 maintenance config; `PUT /v1/system/maintenance` → platform admin only (`ANON` → 401, non-platform user → 403).
`SYS-3` `GET /v1/user-roles` (`supabaseAuth`) → `{isAdmin, role}` (platform role).
`SYS-5` 404 shape — `GET /v1/nonexistent` → `{error:true,message:"Not found",status:404}`. Every state-changing `/v1/*` passes `auditStateChangingRequest`.

---

## 1. GOLDEN PATH (master flow — init → ship → run → merge)

The single flow that, if green, proves the platform end-to-end. Each substep links to a section.

`GOLD-1`
1. `kortix init -y` in an empty dir → writes `kortix.toml` + `.kortix/`, wires agent skill, `git init -b main`. No API call. (§2)
2. `kortix login --token $PAT` → `GET /accounts/me` → 200, host saved active. (§2)
3. `kortix ship -y` (no `origin` present) → managed path: `POST /projects/provision` → 201 `{push_token, repo_id, repo_url}`; `git remote add origin <freestyle>`; commit; token-header push; writes `.kortix/link.json`. (§14)
4. Poll `GET /projects/:id/snapshots` → wait for a `ready` snapshot. (§4)
5. `kortix secrets set OPENAI_API_KEY=sk-…` → `POST /projects/:id/secrets` → 200. (§6)
6. `kortix sessions new -p "add a README"` → `POST /projects/:id/sessions` → 201 status `provisioning`; branch `<sessionId>` created. (§7)
7. Poll `GET /projects/:id/sessions/:sid/sandbox` → status `provisioning`→`active`. (§8)
8. `POST /p/<sandboxId>/8000/session` then `POST /p/<sandboxId>/8000/session/<ocId>/prompt_async` → 204; subscribe `GET /p/<sandboxId>/8000/event` (SSE) → see message deltas; agent commits to branch. (§9)
9. `POST /projects/:id/change-requests {head_ref:<sessionId>, title}` → 201; `GET …/:crId/merge-preview` → mergeable; `POST …/:crId/merge` → 200 status `merged`. (§11)
10. `DELETE /projects/:id/sessions/:sid` → 200 status `stopped` (branch preserved). (§7)

---

## 2. CLI — local + auth (no/low API)

`INIT-1` `kortix init -y` empty dir → `kortix.toml` + `.kortix/` (Dockerfile, `.kortix/opencode/…`, canonical skill) written, agent skill wired (codex default → `AGENTS.md`; `--primary opencode|claude|cursor` → respective skill file/symlink), `git init -b main`. **Zero API calls.** Exit 0.
`INIT-2` `kortix init` when `kortix.toml` exists, no `--force` → exit 1 (refuses).
`INIT-3` `kortix init --primary opencode --agents claude,cursor -y` → primary + extra agent wiring written.
`INIT-4` `kortix init --no-git` → no repo created.
`CREATE-1` `kortix <name>` (bare name, not a known/reserved subcommand) → creates sibling dir, scaffolds, `git init`, `git commit "chore: init kortix project"`. No API. Reserved names (`apps accounts mcp tunnel logs start stop restart open status`) → exit 2.
`LOGIN-1` `kortix login --token kortix_pat_…` → validate `kortix_pat_` prefix → `GET /accounts/me` → 200 → host saved + active in `~/.config/kortix/config.json` (mode 0600).
`LOGIN-2` `kortix login` (browser) → spins one-shot `127.0.0.1:<port>` callback with 32-byte `state`, opens `$WEB/cli/authorize?callback=…&state=…`; dashboard POSTs `{state,token}`; state-mismatch or non-`kortix_pat_` → rejected; valid → `GET /accounts/me` → saved.
`LOGIN-3` `kortix login --token <bad>` → `GET /accounts/me` 401 → "token rejected", exit 1.
`LOGIN-4` already-logged-in host, no flags → no-op.
`WHOAMI-1` `kortix whoami` → `GET /accounts/me` → prints email/user_id/active account/role. 401 → re-login prompt.
`LOGOUT-1` `kortix logout` → removes host creds; if active, switches to next host or deletes config. No API.
`HOSTS-1..6` `kortix hosts ls|use|add|rm|info|current` → config-only; `add --login` delegates to LOGIN; `rm` guards removing last active host.

---

## 3. Access gating / signup (public)

`ACC-2` `POST /access/check-email {email}` → 200 allowed/blocked.
`ACC-4` (self-hosted only, `isLocal()`) `GET /setup/install-status` + `GET /setup/sandbox-providers` → public; `POST /setup/bootstrap-owner` → first owner; `GET /setup/status|health|setup-status`; `GET/POST /setup/setup-wizard-step`, `POST /setup/setup-complete`. Cloud → routes 404.

---

## 4. Accounts & identity

`ME-1` `GET /accounts/me` → 200 user + memberships. `ANON` → 401.
`ACCT-1` `GET /accounts` → list memberships (auto-claims pending invites by email).
`ACCT-2` `POST /accounts {name}` → 201 team account, caller = `owner` (`account_members` row).
`ACCT-3` `GET /accounts/:id` → member → 200; `NONMEMBER` → 403.
`ACCT-4` `PATCH /accounts/:id {name}` → `ACCOUNT_WRITE` (OWNER/ADMIN) → 200; `MEMBER` → 403.

### Members
`MEM-1` `GET /accounts/:id/members` → member → 200.
`MEM-2` `POST /accounts/:id/members {email,role}` → `MEMBER_INVITE` (OWNER/ADMIN) → **201** (`status:added` existing user / `status:pending` new); already a member → 409; `MEMBER` → 403.
`MEM-3` `PATCH /accounts/:id/members/:userId {role}` → `MEMBER_UPDATE` → 200; same role → 200 `{unchanged:true}` (no-op); **promoting/demoting `owner` additionally requires `MEMBER_SUPER_ADMIN_GRANT`** (owner only) → ADMIN owner-grant → 403; **promotion to owner/admin deletes the member's `project_members` rows + project policies**.
`MEM-4` `DELETE /accounts/:id/members/:userId` → `MEMBER_REMOVE`; ADMIN removing an OWNER → 403; removing the **last owner** → 409; also cascades the member's `project_members` rows + IAM policies.
`MEM-5` `POST /accounts/:id/leave` → 200; **last owner** → 409; **personal account** → 409; **non-member → 404**.

### Invites (accept side)
`INV-1` `GET /accounts/:id/invites` → member → list pending.
`INV-2` `DELETE /accounts/:id/invites/:inviteId` / `POST /accounts/:id/invites/:inviteId/resend` → `MEMBER_INVITE`.
`INV-3` `GET /account-invites/:inviteId` → describe pending invite (auth; redacts on email mismatch).
`INV-4` `POST /account-invites/:inviteId/accept` → 200 membership created (rate-limited); already accepted by this user → 200 `{already_accepted:true}`; **expired → 410**; wrong email → 403.
`INV-5` `POST /account-invites/:inviteId/decline` → 200; already accepted → 409; wrong email → 403; not found → 404.

### Account PATs (CLI tokens)
`TOK-1` `GET /accounts/tokens` → list.
`TOK-2` `POST /accounts/tokens {name}` → `TOKEN_CREATE` → 201, `secret_key` returned **once** (absent from list). Account-scoped only — this route does **not** accept `projectId`; project-scoped PATs are minted via the project cli-token route (GH-8).
`TOK-3` `DELETE /accounts/tokens/:tokenId` → `TOKEN_REVOKE` → 200; unknown/already-revoked → 404; revoked token on any route → 401.
`TOK-4` project-scoped PAT (`projectId` set): allowed only on its own project + `/accounts/me`; **everything else → 403** (other project, `/accounts/*`, project-list, and all other surfaces — `enforceTokenProjectScope`).

### Account deletion
`DEL-1` `GET /billing/account/deletion-status` → state.
`DEL-2` `POST /billing/account/request-deletion` → schedules; `POST /billing/account/cancel-deletion` → cancels; `DELETE /billing/account/delete-immediately` → purges.

---

## 5. IAM (groups / policies / roles / super-admin)

All under `/accounts/:id/iam/*`, each route gated by its named action. Run every one as the gating role (2xx) and as `MEMBER` (403).

`IAM-1` `GET …/iam/groups` (`GROUP_READ`) · `POST` (`GROUP_CREATE`) → 201.
`IAM-2` `GET/PATCH/DELETE …/iam/groups/:gid` (`GROUP_READ`/`UPDATE`/`DELETE`).
`IAM-3` `GET …/iam/groups/:gid/members` (`GROUP_READ`); `POST`/`DELETE …/members/:userId` (`GROUP_MEMBERS_MANAGE`).
`IAM-4` `GET …/iam/policies` (`POLICY_READ`) · `POST`/`PATCH …/:pid` (`POLICY_CREATE`) · `DELETE …/:pid` (`POLICY_DELETE`). `POST` body `{principalType: member|group|token, principalId, scopeType, scopeId, roleId, effect: allow|deny}`. **`scopeType=account` requires `scopeId=null`** (else 400); non-account scope requires `scopeId` (else 400); `role.resourceType` must match `scopeType` (else 400); unique-violation → 409.
`IAM-5` `GET …/iam/roles` · `…/roles/:rid/permissions` · `…/roles/:rid/usage` · `…/iam/actions` (all `ROLE_READ`).
`IAM-6` `POST …/iam/roles {key,resource_type,actions[]}` (`ROLE_CREATE`); action list with a string ∉ catalog → 400; dup key → 409. `PATCH …/:rid` / `PUT …/:rid/permissions` (`ROLE_UPDATE`); `DELETE …/:rid` (`ROLE_DELETE`), in-use → 409. **System roles (`account_id=NULL`) are immutable → PATCH/PUT/DELETE → 403.**
`IAM-7` `PATCH …/iam/members/:userId/super-admin {isSuperAdmin:bool}` (`MEMBER_SUPER_ADMIN_GRANT`, OWNER only) → grant/revoke super-admin; ADMIN → 403.
`IAM-8` `GET …/iam/members/:userId/groups` · `…/effective` (`MEMBER_READ`) → effective permission set.

### Engine semantics (assert via behavior, not endpoints)
`IAM-9` **super-admin bypass** — OWNER allowed everything before any policy.
`IAM-10` **deny-wins** — `DENY_USER` with allow+deny on same action/scope → denied.
`IAM-11` **token-only eval** — PAT with ≥1 narrowing policy evaluated on its policies alone (no super-admin, no legacy bridge); PAT with 0 policies inherits minter.
`IAM-12` **legacy bridges** — `member` gets account-reads only (no `project.*`, so cannot list all projects); owner/admin → Administrator action set; `project_members` row → bridged project role.
`IAM-13` **scope match** — policy with `scope_id=NULL` matches all resources of type; with `scope_id` matches only that resource.

---

## 6. Projects — CRUD + access

DB `projects` (`status active|archived`, unique `(account_id, repo_url)`). Soft delete → `archived`.

`PROJ-1` `GET /projects` → OWNER/ADMIN: all account projects; `MEMBER`: only `project_members` grants; `NONMEMBER`: empty/own only.
`PROJ-2` `POST /projects {repo_url,name}` (BYO) → `PROJECT_CREATE` (OWNER/ADMIN) → 201, creator granted `manager`, snapshot build kicked. `MEMBER` → 403. Non-GitHub `repo_url` → 400.
`PROJ-3` `POST /projects/provision {name,provider:freestyle}` (managed) → `PROJECT_CREATE` → 201 `{push_token,repo_id,repo_url}`. Missing `FREESTYLE_API_KEY` → 503.
`PROJ-4` `POST /projects/create-repo {name,private?}` (new GitHub repo) → `PROJECT_CREATE` → 201; no account GitHub App install → 409 + `install_url`; auto-dedupes name collision.
`PROJ-5` `GET /projects/:id` → `read` → 200 (bumps `last_opened_at`); archived → 404; `NONMEMBER` → 403.
`PROJ-6` `GET /projects/:id/detail` → `read` → 200 project + parsed `kortix.toml` (agents/skills/env) + file list.
`PROJ-7` `PATCH /projects/:id {name,default_branch,manifest_path}` → `manage` (M_MANAGER/OWNER/ADMIN) → 200; M_EDITOR/M_VIEWER → 403.
`PROJ-8` `DELETE /projects/:id` → `manage` → 200 status `archived`; M_EDITOR → 403.

### Project access (membership)
`PACC-1` `GET /projects/:id/access` → `read` → members + effective project roles.
`PACC-2` `POST /projects/:id/access/invite {email,role}` → `manage` → 200; target without a Kortix account → 404 ("invite to org first"); auto-adds to org as `member` (`ensureOrgMembership`).
`PACC-3` `PUT /projects/:id/access/:userId {role}` → `manage`.
`PACC-4` `DELETE /projects/:id/access/:userId` → `manage`.

---

## 7. Sessions (ephemeral branch + sandbox)

DB `project_sessions` (`status queued|branching|provisioning|running|stopped|failed|completed`, unique `(project_id, branch_name)`). Branch name = `session_id`.

`SESS-1` `POST /projects/:id/sessions {agent_name?,initial_prompt?,base_ref?,provider?,name?,session_id?,branch_already_created?}` → `write` (M_EDITOR/M_MANAGER) → 201 status `provisioning` (fire-and-forget sandbox). M_VIEWER → 403.
`SESS-2` concurrency cap — Nth session over tier cap → **429** + `X-RateLimit-Limit/-Remaining` headers.
`SESS-3` CLI client-branch optimization — `kortix sessions new`: if server can't self-create branch (not managed-freestyle, not GitHub app/pat) AND local `origin` == `project.repo_url`, CLI mints uuid, `git push origin HEAD:refs/heads/<uuid>`, then posts `session_id`+`branch_already_created:true`+`base_ref`.
`SESS-4` `GET /projects/:id/sessions` → `read` → list (updatedAt desc).
`SESS-5` `GET /projects/:id/sessions/:sid` → `read` → 200; non-uuid `sid` → 400.
`SESS-6` `PATCH /projects/:id/sessions/:sid {name?,opencode_session_id?,metadata?}` → `write`; attempting `status`/`sandbox_url`/`error` → 400 (server-managed).
`SESS-7` `DELETE /projects/:id/sessions/:sid` → `write` → 200 soft-delete status `stopped`; **remote branch preserved**.
`SESS-8` `GET /projects/:id/sessions/:sid/sandbox` → `read` → `session_sandboxes` row; **404 while row not yet inserted** (frontend polls); then status `provisioning`→`active` with `base_url`/`external_id`.
`SESS-9` `POST /projects/:id/sessions/:sid/restart` → `write` → **202**; tears down container, revokes sandbox keys, re-provisions with rotated git/LLM/CLI tokens (status→`provisioning`); branch preserved.
`SESS-10` `POST /projects/sync-opencode-titles {entries[]}` → mirrors OpenCode titles → `metadata.name` (per-row write check).

---

## 8. Sandbox lifecycle + snapshots

`SNAP-1` `GET /projects/:id/snapshots` → `read` → list `kortix-snap-…` images per baseRef. **Session boot requires a `ready` snapshot of baseRef** (no shared fallback → session `failed` if none).
`SNAP-2` `POST /projects/:id/snapshots/rebuild` → **`manage` AND account `ACCOUNT_WRITE` (owner/admin)** → rebuild image. A project `manager` who is not owner/admin → 403; M_EDITOR → 403.
`SBX-1` sandbox create/start = implicit on session create (`provisionSessionSandbox`); no standalone endpoint.
`SBX-2` sandbox stop = session `DELETE`; restart = `SESS-9`; status read = `SESS-8`.

---

## 9. Agent run (OpenCode via preview proxy)

All under `/p/:sandboxId/:port/*` (`combinedAuth` + rate-limit). `:sandboxId` = `external_id` (Daytona) / container name (local). `:port` = `8000` for OpenCode. Auth via header / `X-Kortix-Token` / `?token=` / `__preview_session` cookie.

`PRX-1` `POST /p/auth` (JWT or token) → 200 sets `__preview_session` cookie (1h). Invalid token → 401.
`PRX-2` `POST /p/share` → `combinedAuth` → 201 share link; `GET /p/share` → list; `DELETE /p/share/:token` → revoke. Shared link grants scoped preview access.
`RUN-1` `POST /p/<sbx>/8000/session` → create OpenCode conversation → returns `{id}`.
`RUN-2` `POST /p/<sbx>/8000/session/<ocId>/prompt_async {parts:[{type:text,text}]}` → **204** (async; agent runs in background).
`RUN-3` `GET /p/<sbx>/8000/event` (SSE) → stream message/part deltas + `session.updated`; assert text streamed.
`RUN-4` busy/idle — `GET /p/<sbx>/8000/session/<ocId>` → `status.type ∈ busy|retry` ⇒ busy.
`RUN-5` `POST /p/<sbx>/8000/session/<ocId>/abort` → stop a running agent.
`RUN-6` `GET /p/<sbx>/8000/session/<ocId>/message` (+`/message/<mid>`) → list/get messages (results).
`RUN-7` `GET /p/<sbx>/8000/session/<ocId>/diff` → working-tree diff; agent commits land on branch `<sessionId>`.
`RUN-8` proxy authz — request without any valid token/cookie → 401; preview-token from a `share` → scoped 200.

## 10. Files (read via git API; write via sandbox)

Repo files are read-only over the project API; live edits happen in the sandbox (OpenCode file API via proxy) or via manifest commits. All git reads are `read`.

`FILE-1` `GET /projects/:id/files?ref=&path=` → file/dir listing.
`FILE-2` `GET /projects/:id/files/content?path=&ref=` → file text; **absent `path` param → 400**; non-existent file path is uncaught → surfaces 500 (not 404).
`FILE-3` `GET /projects/:id/files/search?q=&content=1&ref=&limit=` → filename + grep.
`FILE-4` `GET /projects/:id/files/history?path=` → commit history for path.
`FILE-5` `GET /projects/:id/files/archive?path=&ref=` → zip stream.
`FILE-6` `GET /projects/:id/branches` → branches.
`FILE-7` `GET /projects/:id/commits?ref=&path=` · `GET …/commits/:sha` · `GET …/commits/:sha/diff`.
`FILE-8` `GET /projects/:id/version-diff?from=|head=&into=|base=` → diff between two refs (params are `from`/`head` and `into`/`base` — there is **no `to`**).
`FILE-9` live file CRUD inside sandbox → through proxy to OpenCode file API on `:8000` (create/read/update/delete/list). Durable truth = git repo; sandbox tree is ephemeral.

---

## 11. Change Requests (mandatory path to land branch work on main)

DB `change_requests` (per-project `number`, `status open|merged|closed`).

`CR-1` `GET /projects/:id/change-requests?status=open|merged|closed|all` → `read`.
`CR-2` `POST /projects/:id/change-requests {title,head_ref,base_ref?,description?,session_id?}` → `write` → 201, head/base SHAs anchored. Missing `title` → 400; missing `head_ref` → 400; `base_ref==head_ref` → 400.
`CR-3` `GET …/:crId` → `read` (auto-refreshes branch tips).
`CR-4` `PATCH …/:crId` → `write`, open only.
`CR-5` `GET …/:crId/diff` → `read` → file list + unified patch.
`CR-6` `GET …/:crId/merge-preview` → `read` → mergeable / fast-forward / conflicts.
`CR-7` `POST …/:crId/merge {message?}` → **`write` required** → 200 status `merged` + sha; not-open → 409.
`CR-8` `POST …/:crId/close` · `POST …/:crId/reopen` → `write`.
`CR-9` CLI mirror: `kortix cr ls|show|diff|open|merge|close|reopen` (reads `KORTIX_PROJECT_ID` inside sandbox).
`CR-10` response envelopes (assert shape): list → `{change_requests:[…]}`, get → `{change_request:{…}}`, merge → `{change_request, merge}`. (Project DELETE returns `{ok:true}`, not an echoed status.)

---

## 12. Triggers (cron + webhook; source of truth = `kortix.toml`)

Specs in `[[triggers]]`; CRUD commits the manifest; runtime `last_fired_at` in `project_trigger_runtime`. Types: `cron`, `webhook` only.

`TRG-1` `GET /projects/:id/triggers` → `read` → specs + `last_fired_at` + parse `errors` + `webhook_url`.
`TRG-2` `POST /projects/:id/triggers {name(required),slug?,type,agent?,enabled?,prompt_template,cron?,timezone?,secret_env?}` → `manage` → 201, manifest committed; `name` is required (slug derived from it when omitted); duplicate slug → 409. `webhook` requires `secret_env` (names a `project_secrets` key, regex `^[A-Z_][A-Z0-9_]*$`). `cron` requires 6-field croner expr + IANA `timezone` (default UTC).
`TRG-3` `PATCH /projects/:id/triggers/:slug` (e.g. `{enabled:false}`) → `manage`.
`TRG-4` `DELETE /projects/:id/triggers/:slug` → `manage` (also drops runtime row).
`TRG-5` `POST /projects/:id/triggers/:slug/fire` → `manage` → manual fire → 202 `{status:fired,session_id}`; under backpressure → 202 `{status:queued,reason}`.
`TRG-6` cron scheduler — global `setInterval` (default 60s), sweeps ≤200 active projects; due = `nextCronRun(cron,lastFired,tz) ≤ now`; **marks fired BEFORE firing** (no double-spawn per slot). Disabled via `KORTIX_TRIGGER_SCHEDULER_ENABLED=false`.
`TRG-7` webhook fire — `POST /webhooks/projects/:id/:slug` (**public, HMAC**). Sig header `X-Kortix-Signature` or `X-Hub-Signature-256` (`sha256=` stripped), HMAC-SHA256 over raw body vs `project_secrets[secret_env]`, constant-time. Valid → 202 fired/queued; malformed UUID/slug → 400; unknown project → 404; bad sig → 401; missing secret → 409; unknown/disabled/non-webhook trigger → 404; fire failure → 500.
`TRG-8` fire→run — `fireGitTrigger` → actor = account's first `owner` (no owner → silent fail), `createProjectSession(enforceAccountCap:false, metadata.trigger_*)`. Backpressure: provisioning sessions ≥3 OR account at tier cap → queued.
`TRG-9` **No inbound GitHub event webhook exists.** Simulate "GitHub Actions"-style automation as a generic `webhook` trigger; a GitHub repo webhook can drive it if its secret == `secret_env` (via `X-Hub-Signature-256`).

---

## 13. Channels (Slack)

Tokens stored as encrypted project secrets; webhooks public + signature-gated.

`CHN-1` `kortix channels connect --bot-token xoxb-… --signing-secret …` → validates `xoxb-` via `auth.test` → `POST /projects/:id/channels/slack/connect` (`manage`) → 200, prints webhook `$API/webhooks/slack/:id`.
`CHN-2` `GET /projects/:id/channels/slack/installation` → `read` → workspace/team/bot/url or "not connected".
`CHN-3` `DELETE /projects/:id/channels/slack/installation` → `manage`.
`CHN-4` Slack inbound (OAuth mode) — `POST /webhooks/slack` (shared `SLACK_SIGNING_SECRET`): `v0=HMAC(v0:{ts}:{body})`, ±5min replay window; `url_verification` → echo `challenge`; `event_callback` routed by `team_id`→binding→project.
`CHN-5` Slack inbound (BYO mode) — `POST /webhooks/slack/:id` (per-project signing secret).
`CHN-6` Slack dispatch — `app_mention`/IM/threaded `message` → existing thread session → deliver to sandbox `/kortix/prompt` (`delivered|transient|stale`); else `createProjectSession` (actor=owner, agent `default`) + record `chat_threads`.
`CHN-7` Slack OAuth — `GET /webhooks/slack/oauth/callback` (signed `state`, 10-min TTL) → exchange code → `saveSlackInstall`.
`CHN-9` bad sig on any channel webhook → 401. Not configured → **503 (Slack OAuth mode + OAuth callback)** but **404 (Slack BYO)**.

---

## 14. GitHub integration + `kortix ship`/`deploy`

GitHub is **outbound only** (repo create, Contents API commits, installation-token git transport). No inbound event receiver.

### GitHub App install (account-level, dashboard)
`GH-1` `GET /projects/github/installation?account_id=` → `ACCOUNT_WRITE` → 200; if none → returns `install_url` (`github.com/apps/<slug>/installations/new?state=<hmac>`), state row TTL 30min.
`GH-2` user installs on GitHub → redirect → `$WEB/github/setup?installation_id=&state=&setup_action=install` → `POST /projects/github/installation {state,installation_id}` → verify HMAC + iat window + one-time nonce consume → fetch real owner via `GET api.github.com/app/installations/{id}` → upsert `account_github_installations`.
`GH-3` `DELETE /projects/github/installation?account_id=` → `ACCOUNT_WRITE` → disconnect. `setup_action=uninstall` → frontend "removed".
`GH-4` Supabase GitHub OAuth popup (user PAT, distinct from App) — `signInWithOAuth(github, scopes 'repo read:user')`, `provider_token` posted back to opener.
`GH-5` git transport resolution (`resolveProjectGitAuth`): freestyle-managed (mint scoped push token) / GitHub App (fresh installation token) / `project_secret` token / server PAT / none.
`GH-6` `PUT /projects/:id/git-credential` (BYO) → `manage` → set git auth secret; already server-managed → 409.
`GH-7` `POST /projects/:id/git-token` → mint fresh Freestyle push token; **409 for BYO**; 503 if Freestyle unconfigured.
`GH-8` `GET/POST/DELETE /projects/:id/cli-token[/:tokenId]` → project-scoped CLI tokens.

### `kortix ship` (alias `deploy`)
`SHIP-1` first ship, no `origin` → managed: `POST /projects/provision` → set `origin` to freestyle URL, commit, header-injected token push, write `link.json`. Requires `PROJECT_CREATE`.
`SHIP-2` first ship, existing `origin` → **BYO** (single-writable-origin rule): `POST /projects {repo_url,name}`, **origin never modified**, push with user's own creds.
`SHIP-3` first ship `--origin <git-url>` → BYO explicit; only this case rewrites `origin` (`git remote set-url`).
`SHIP-4` first ship `--origin freestyle` → force managed even if origin exists.
`SHIP-5` multiple accounts + no `--account`/`-y` → interactive pick; `--account <id|slug>` mismatch → error listing slugs.
`SHIP-6` subsequent ship (linked) → `GET /projects/:id` (403→access guidance, 404→gone guidance); managed → `POST /projects/:id/git-token` (fresh token per ship) → commit + push; BYO → `ensureOrigin` only if missing.
`SHIP-7` `kortix ship -n/--dry-run` → prints would-be calls, **no side effects**.
`SHIP-8` `kortix ship` outside a git repo or non-Kortix dir → error; not logged in → "run kortix login"; 503 → "managed git not configured; pass --origin <git-url>".
`SHIP-9` `--no-commit` with dirty tree → error; clean tree + HEAD → skip commit, push only.

### CLI resource commands (project-scoped)
`CLI-PROJ` `kortix projects ls|info|link|unlink|open|rm` → `GET /projects`, `GET /projects/:id`, `DELETE /projects/:id[?purge=true]` (`--purge` deletes managed Freestyle repo; BYO untouched).
`CLI-SESS` `kortix sessions ls|new|info|restart|rm|open` → maps to §7.
`CLI-SEC` `kortix secrets ls|set|unset` + `kortix env pull|push` → maps to §6 (values write-only).
`CLI-TRG` `kortix triggers ls|fire|enable|disable|info` → maps to §12.

---

## 15. Secrets / env

DB `project_secrets` (AES-256-GCM, key bound to `projectId`, unique `(project_id,name)`). **Write-only API — values never returned.**

`SEC-1` `GET /projects/:id/secrets` → `manage` → names only + manifest required/optional keys + virtual git-auth row.
`SEC-2` `POST /projects/:id/secrets {name,value}` → `manage` → upsert (encrypt); name upper-cased; invalid name format → 400; `KORTIX_*` reserved → 400. M_EDITOR/M_VIEWER → 403.
`SEC-3` `DELETE /projects/:id/secrets/:name` → `manage`; invalid name → 400; system secret (git-auth) → 403.
`SEC-4` injection — `buildSessionSandboxEnvVars` decrypts **all** project secrets into the session env (project-global, no per-member scoping) + minted `KORTIX_TOKEN`/`KORTIX_CLI_TOKEN`, `KORTIX_LLM_*`, `KORTIX_GIT_AUTH_TOKEN`, etc.

---

## 16. Billing (gated by `KORTIX_BILLING_INTERNAL_ENABLED`; off → 404 `billing_disabled`)

`BILL-1` `GET /billing/account-state` (always available; off → unlimited mock).
`BILL-2` `POST /billing/setup/initialize {server_type,location}` → free Stripe sub.
`BILL-3b` `POST /billing/create-checkout-session` · `create-per-seat-checkout` · `create-portal-session`.
`BILL-4` `POST /billing/sync-subscription`.
`BILL-5` `POST /billing/purchase-credits`; `GET /billing/transactions`.
`BILL-6` auto-topup: `GET …/auto-topup/settings|setup-status` · `POST …/auto-topup/configure`.
`BILL-8` `POST /billing/webhooks/stripe` — Stripe sig: missing sig → 400, misconfigured secret → 500. `POST /billing/webhooks/revenuecat` — **Bearer-token auth, bad → 401** (not an in-body sig). Both public, no auth middleware.
`BILL-9` write ops require `billing.write` — `BILLING` ok, `MEMBER`/`AUDITOR` → 403.

---

## 17. Router / LLM / proxy (sandbox-facing; `apiKeyAuth`)

`RTR-1` `POST /router/web-search {query}` · `POST /router/image-search` → `APIKEY` → 200; `ANON`/JWT → 401.
`RTR-2` `POST /router/chat/completions {model,messages,stream}` (OpenAI-compat) · `GET /router/models` · `GET /router/models/:model` · `POST /router/messages` (Anthropic-style).
`RTR-4` billed proxy passthrough `ALL /router/:service[/*]` for `tavily|serper|firecrawl|replicate|context7|anthropic|openai|xai|gemini|groq` — Kortix token → managed keys; user key + `X-Kortix-Token` → passthrough; disallowed service/route → 4xx.
`LLM-1` managed LLM gateway `GET /llm/health` · `GET /llm/models` · `POST /llm/chat/completions`; disabled gateway → 503, missing OpenRouter key → 500, configured chat without bearer → 401.

---

## 18. Platform / OAuth2 provider / Tunnel / Servers / Deployments

### Platform API keys
`PLT-2` `GET/POST /platform/api-keys` · `PATCH /platform/api-keys/:keyId/revoke` · `DELETE /platform/api-keys/:keyId` · `POST …/:keyId/regenerate` (`supabaseAuth`).

### OAuth2 provider (Kortix as IdP for CLI/MCP/tunnel)
`OAU-1` `GET /oauth/authorize` (public) → redirect to consent.
`OAU-2` `GET /oauth/authorize/consent/:requestId` (auth) → consent data; `POST /oauth/authorize/consent` → submit.
`OAU-3` `POST /oauth/token` (public, **form-encoded**) — requires `grant_type` ∈ {`authorization_code`,`refresh_token`} (others → `unsupported_grant_type`) + `client_id`+`client_secret` (missing → 400, bad → 401 `invalid_client`).
`OAU-4` `GET /oauth/userinfo` (`oauthTokenAuth`; `oauthTokenAuth` is local to `oauth/index.ts`, not a shared middleware).

### Tunnel (reverse tunnel to local machines)
`TUN-1` connections `GET/POST /tunnel/connections`, `GET/PATCH /:tid`, `POST /:tid/rotate-token`, `DELETE /:tid`.
`TUN-2` permissions `GET/POST /tunnel/permissions/:tid`, `DELETE /:tid/:permissionId`; requests `GET /tunnel/permission-requests`, `GET …/stream` (SSE), `POST /:rid/approve|deny`.
`TUN-3` rpc `POST /tunnel/rpc/:tid`; audit `GET /tunnel/audit/:tid`.
`TUN-4` device auth (public) `POST /tunnel/device-auth`, `GET …/:code/status`; (auth) `GET …/:code/info`, `POST …/:code/approve|deny`.
`TUN-5` WS `GET /tunnel/ws?tunnelId=` — auth via first message; rate-limited.

### Servers (MCP registry)
`SRV-1` `PUT /servers/sync` · `GET/POST /servers` · `DELETE /servers/:id` (`combinedAuth`).

### Deployments (gated `KORTIX_DEPLOYMENTS_ENABLED`)
`DEP-1` `POST /deployments` · `GET /deployments[/:id]` · `POST /:id/stop|redeploy` · `DELETE /:id` · `GET /:id/logs` (`combinedAuth`).

### Apps (experimental `KORTIX_APPS_EXPERIMENTAL`, `[[apps]]` in manifest)
`APP-1` `GET /projects/:id/apps` (`read`) · `POST` (`manage`) · `PATCH/DELETE /:slug` (`manage`) · `POST /:slug/deploy|stop` (`manage`) · `GET /:slug/logs` (`read`).

### Ops (platform admin)
`OPS-1` `GET /ops/overview` → `requireAdmin` (platform admin/super_admin) → 200; non-admin → 403.

---

## 19. Cross-cutting boundary / negative matrix

Run these against representative endpoints from each domain.

`SEC-A` `ANON` (no header) on any protected route → 401.
`SEC-B` malformed/expired JWT → 401; revoked PAT/api-key → 401.
`SEC-C` `NONMEMBER` on `GET/PATCH/DELETE /accounts/:id`, `/projects/:id` → 403/404.
`SEC-D` project-scoped PAT: allowed only on its bound project + `/accounts/me`; **every other surface → 403** (cross-project, `/accounts/*`, project-list, router/billing/channels/etc.).
`SEC-E` 404 shape — `GET /v1/nonexistent` → `{error:true,message:"Not found",status:404}`.
`SEC-F` webhook sig bypass — Stripe/RevenueCat/Slack/project-webhook with missing/wrong sig → 400/401.
`SEC-G` preview proxy without token/cookie → 401; cross-sandbox token reuse → 403.
`SEC-H` audit — every state-changing `/v1/*` writes an audit row (`auditStateChangingRequest`); assert `GET /accounts/:id/audit` reflects a prior mutation.
`SEC-I` rate limits — session create (429), invite-accept, preview proxy, tunnel WS each return their limiter response under load.

### Role × project-action grid (assert per row)

| Action level | OWNER | ADMIN | M_MANAGER | M_EDITOR | M_VIEWER | MEMBER (no grant) | NONMEMBER |
|---|---|---|---|---|---|---|---|
| `read` (GET project/files/sessions) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 |
| `write` (session create/CR merge/PATCH session) | ✓ | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 | ✗ 403 |
| `manage` (PATCH/DELETE project, secrets, triggers, access) | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 |

### Role × account-action grid

| Action | OWNER | ADMIN | BILLING | AUDITOR | MEMBER |
|---|---|---|---|---|---|
| `account.read` / member.read / audit.read | ✓ | ✓ | ✓ | ✓ | ✓ |
| `account.write` (rename) | ✓ | ✓ | ✗ | ✗ | ✗ |
| `member.invite/update/remove` | ✓ | ✓ | ✗ | ✗ | ✗ |
| `member.super_admin.grant` (owner role) | ✓ | ✗ | ✗ | ✗ | ✗ |
| `billing.write` | ✓ | ✗ | ✓ | ✗ | ✗ |
| `account.delete` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `project.create` | ✓ | ✓ | ✗ | ✗ | ✗ |

---

## 20. Status enums (for assertions)

- project: `active | archived`
- session: `queued | branching | provisioning | running | stopped | failed | completed`
- sandbox (session_sandboxes): `provisioning | active | stopped | error | archived` (legacy `sandboxes` table also has `pooled`)
- snapshot: `queued | building | ready | failed` (session boot needs a `ready` snapshot of baseRef)
- change request: `open | merged | closed`
- trigger fire result: `fired | queued | failed`

## 21. Known gaps (don't write tests for these — they don't exist)

- No account-level vault — secrets are project-scoped, all-or-nothing per project (the `vault_items`/per-member-scope design was reversed).
- Granular IAM actions `project.trigger.*`, `channel.*`, `trigger.*`, `project.session.*` exist in the catalog but project routes only enforce coarse `read|write|manage` — test the coarse gate, not the fine actions.
- No inbound GitHub event webhook (no push/PR receiver) — see `TRG-9`.
- CLI `providers`, `doctor`, `proxy`, `sessions-chat` source files exist but are **not wired** into the dispatcher and not in the reserved list — so `kortix providers …` is **treated as a new-project name** (`runCreate`), not an "unknown command" error. Don't test for an error here.
- Cron scheduler scans only first 200 active projects/tick.

---

## 22. Coverage & dead-code (how to know what every test actually hits)

Goal: run the flows above and learn, per function across the whole stack, what got executed — so we can flag dead code. Two complementary signals; neither alone proves "dead".

### The hard constraint
The API and CLI run on **Bun (JavaScriptCore, not V8)**. So `NODE_V8_COVERAGE`, `c8`, `nyc`, `v8-to-istanbul` **do not work** for them. The only Bun-native coverage is `bun test --coverage` (function + line `%`, lcov reporter), and it **only instruments code loaded inside the `bun test` process** — a separately-spawned `bun src/index.ts` server hit by curl yields **zero** coverage. The browser is Chromium/V8, so frontend coverage is unaffected by this.

### (A) Static dead-code — do first, highest ROI, no Bun limits
Truly-never-imported symbols, found without running anything:
```bash
pnpm add -Dw knip madge
pnpm exec knip                                   # unused files, exports, deps (pnpm-workspace aware)
pnpm exec madge --circular --extensions ts,tsx apps/api/src
# lighter alt: pnpm dlx ts-prune -p apps/api/tsconfig.json
```
`knip` needs entry points configured (`apps/api/src/index.ts` + `scripts/*.ts`; `apps/cli/src/index.ts`; web next config + `app/`; each package `exports`). Output = the real dead-code list.

### (B) Runtime reachability from this suite — per app (different runtimes)
- **API (Bun):** the working path is **in-process** — implement curl flows as a `bun test` driver that imports the *real* app and calls `app.fetch(new Request(...))`. The real app is exported at `apps/api/src/index.ts` (`export default { fetch }`). Then:
  ```bash
  cd apps/api && bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage src/__tests__/e2e-*.test.ts
  ```
  `bunfig.toml` sets `isolation=true` (process-per-file) → one lcov per file; merge them. **Curl-against-a-live-server gives no coverage** — convert those flows to in-process `fetch` to capture them. (Status codes etc. are identical; only the transport changes.)
- **CLI (Bun):** same — drive `main(argv)` / command modules in-process under `bun test --coverage`. Never spawn the built binary (uninstrumented).
- **Web (Next 15 / SWC, no babel):** browser runs V8, so use **Playwright + `page.coverage.startJSCoverage()`**, pipe through **`monocart-coverage-reports`** (V8→Istanbul, source-map remap to TSX, lcov). No babel/SWC change needed. Higher-fidelity alt: `swc-plugin-coverage-instrument` via `next.config.ts` `experimental.swcPlugins` behind an env flag (more brittle on Next 15). Note Playwright hits the **API over HTTP**, so it does **not** cover server functions — API coverage must come from the `bun test` harness.

### Merge into one report
All three emit lcov:
```bash
pnpm dlx lcov-result-merger 'apps/**/coverage/lcov*.info' merged/lcov.info
# or: pnpm dlx monocart-coverage-reports merge --inputDir apps/api/coverage apps/cli/coverage apps/web/coverage --reporter html,lcov
```
Scale: ~500 exported symbols / ~520 route handlers in `apps/api/src` — a tractable function-level report.

### The load-bearing caveat
**Uncovered ≠ dead.** The e2e suite legitimately won't hit error branches, the cron scheduler, webhook handlers, or rarely-used ops routes — those are live in prod. Only static analysis (A) can claim "never imported." **Dead-code candidate = flagged by knip (A) AND uncovered by the suite (B).** Uncovered-but-imported = "untested," not dead.

### Smallest first step
1. `pnpm add -Dw knip && pnpm exec knip` → the true dead-code list, today.
2. Refactor a couple `apps/api/src/__tests__/e2e-*.test.ts` to drive the real `index.ts` export in-process, run `bun test --coverage` → prove the function-level lcov pipeline on the real app.
3. Add Playwright+monocart for web; merge all lcov into one HTML report; diff against knip.

---

## 24. Connectors (executor)

`CONN-1` `GET /executor/connectors` → executor-principal (sandbox KORTIX_TOKEN) route; user JWT + `ANON` → 401 (200 path exercised in-sandbox).
`CONN-2` `GET /executor/projects/:id/connectors` → project admin → 200; `NONMEMBER` → 403.
`CONN-3` `POST /executor/call {connector,action,args}` → executor-principal route; user JWT + `ANON` → 401.
`CONN-4` `POST /executor/projects/:id/connectors/sync` → admin → 200 (re-materialize from kortix.toml).
`CONN-5` `GET /executor/projects/:id/policies` → admin → 200; `PUT …/policies {policies[]}` → admin → 200.
`CONN-6` `PUT /executor/projects/:id/connectors/:slug/sharing` → invalid mode → 400; unknown connector → 404.
`CONN-7` `PUT /executor/projects/:id/connectors/:slug/credential` → missing value → 400.
`CONN-8` `POST /executor/projects/:id/connectors` → admin; invalid json → 400. `DELETE …/:slug` → admin → ok/404.
`CONN-9` `GET /executor/projects/:id/pipedream/apps` → admin → 200 or 501 (pipedream not configured).

---

## 25. Parallel-authored domains (git/platform/iam/channels/servers/audit/scim)

`GH-9` `GET /git/:project/info/refs` · `POST …/git-upload-pack` · `POST …/git-receive-pack` → smart-HTTP proxy, git token auth (not JWT); bad/no token → 401/502.
`GH-10` `GET /git/:project/info/refs` → user JWT is not a git token → 401/403; NONMEMBER → 401/403/404.
`GH-11` `GET /projects/:id/git/clone-credential` → runtime tokens only; ANON → 401, user JWT/account-PAT → 403.
`GH-12` `POST /projects/:id/git/collaborators` → missing username → 400; non-managed → 409; no install → 502.
`GH-13` `GET /projects/github/repositories` → PROJECT_CREATE; no App install → 409 install_url.
`GH-14` `POST /projects/create-repo` → PROJECT_CREATE; missing name → 400; no install → 409/503.
`GH-15` `POST /projects/link-repository` → PROJECT_CREATE; missing repo → 400; no install → 400/409/502; bad token → 400.
`PLT-4` `GET /platform/api-keys` → 401 ANON; 400 missing/non-UUID sandbox_id; 404 unknown sandbox.
`PLT-5` `POST /platform/api-keys` → 401 ANON; 400 missing/non-UUID sandbox_id; 404 unknown sandbox.
`PLT-6` `DELETE /platform/api-keys/:keyId` → 401 ANON; 404 unknown keyId.
`PLT-7` `POST /platform/api-keys/:keyId/regenerate` → 401 ANON; 404 unknown keyId.
`PLT-8` `PATCH /platform/api-keys/:keyId/revoke` → 401 ANON; 404 unknown keyId.
`IAM-14` `GET …/iam/groups/:gid/project-grants` → 200; unknown → 404; NONMEMBER → 403.
`IAM-15` `POST …/iam/members/:userId/effective:batch` → 200; non-array → 400.
`IAM-16` `GET …/iam/members/:userId/project-access` → 200; NONMEMBER → 403.
`IAM-17` `GET/PATCH …/iam/mfa-required` (+ /preview) → enable w/o MFA → 409 lockout; NONMEMBER → 403.
`IAM-18` `GET/PATCH …/iam/pat-policy` → 200; >2yr → 400; null clears.
`IAM-19` `GET/PATCH …/iam/session-policy` → 200; >10080m → 400; null clears.
`IAM-20` `GET …/iam/sessions` · `POST …/sessions/:sid/revoke` → unknown → 404; NONMEMBER → 403.
`IAM-21` `GET/POST …/iam/scim/tokens` · `DELETE …/:tid` → mint 201 secret-once; missing name → 400; double-revoke → 404.
`IAM-22` `GET/POST …/iam/service-accounts` · `POST …/:saId/disable` · `DELETE …/:saId` → 201 secret-once; double-disable → 409; unknown → 404.
`IAM-23` `GET/PUT/DELETE …/iam/sso/provider` → none={provider:null}; bad UUID/domain → 400; double-delete → 404.
`IAM-24` `GET/POST …/iam/sso/mappings` · `DELETE …/:mid` → no-provider → 409; bad group → 400; unknown delete → 404.
`CHN-10` `GET /projects/:id/channels/slack/mode` → read → 200; non-member 403/404.
`CHN-11` `POST /webhooks/slack/commands` → public, OAuth-gated → 503/401.
`CHN-12` `POST /webhooks/slack/interactivity` → public, OAuth-gated → 503/401.
`SRV-2` `POST /servers` 201 · `DELETE /servers/:id` cleanup.
`SRV-3` `POST /servers` missing fields → 400 · managed id → 400 · unknown delete id → 404.
`SRV-4` `PUT /servers/sync` → 200 rows; non-array → 400; ANON → 401.
`AUD-1` `GET /accounts/:id/audit` → 200; NONMEMBER → 403.
`AUD-2` `GET /accounts/:id/audit/export` → 200 (CSV/JSONL); bad format → 400; NONMEMBER → 403.
`AUD-3` `GET /accounts/:id/audit/webhooks` → 200; NONMEMBER → 403.
`AUD-4` `POST`/`PATCH`/`DELETE /accounts/:id/audit/webhooks[/:id]` → 201 secret-once; bad url → 400; unknown → 404; delete 200.
`SCIM-1` `GET /scim/v2/accounts/:id/ServiceProviderConfig` → SCIM bearer 200; OWNER JWT/no bearer → 401.
`SCIM-2` `GET/POST /scim/v2/accounts/:id/Users` · `GET/PATCH/DELETE …/:userId` → ListResponse; missing userName → 400; idempotent deletes 204; OWNER JWT → 401.
`SCIM-3` `GET/POST /scim/v2/accounts/:id/Groups` · `GET/PATCH/DELETE …/:groupId` → list; missing displayName → 400; create 201.
`SCIM-4` `GET …/ServiceProviderConfig` cross-tenant SCIM token → 403; garbage bearer → 401.

---

## 26. Parallel-authored wave 2 (CR/files/apps/sandboxes/billing/access/router/auth/projects-misc)

`CR-11` `GET/POST /projects/:id/change-requests` → NONMEMBER → 403/404.
`CR-12` `GET /projects/:id/change-requests` → ANON → 401.
`PROJ-10` `POST /projects/:id/cli-token` → 201 project PAT; `GET` → 200; `DELETE /:tokenId` → 200; unknown → 404.
`PROJ-11` `PATCH /projects/:id/onboarding {completed}` → 200; NONMEMBER → 403/404.
`PROJ-12` `GET /projects/:id/version-diff?from&into` → 200; missing → 400; same ref → is_same_ref.
`PROJ-13` `POST /projects/:id/providers/openai/chatgpt/headless/start|complete` → start 200/500; complete missing auth_id → 400.
`PROJ-14` `GET /projects/legacy-migration/eligibility` → 200; `status?sandbox_id` missing → 400; unknown → 404; ANON → 401.
`PROJ-15` `POST /projects/legacy-migration/start {sandbox_id}` → missing → 400; unknown → 404; non-justavps → 400.
`PROJ-16` `POST /projects/:id/turn-question {session_id,questions[]}` → missing → 400.
`PROJ-17` `POST /projects/:id/turn-stream {session_id,text}` → missing → 400.
`APP-2` `POST /projects/:id/apps` · `PATCH/DELETE /:slug` → gate off → 404; bad body → 400; dup → 409; unknown → 404.
`APP-3` `POST /:slug/deploy|stop` · `GET /:slug/logs` → unknown/no-deploy → 404.
`APP-4` `PATCH /projects/:id/apps-config {enabled}` → 200; non-bool → 400 (not behind apps gate).
`SNAP-3` `POST /projects/:id/snapshots/fix-with-agent` → no failed build → 409; else 201.
`SBX-3` `GET /projects/:id/sandbox-health` · `/sandbox-templates` → 200.
`SBX-4` `POST /sandbox-templates` → 201; bad → 400; reserved/dup → 409; `PATCH/DELETE/build /:templateId`; unknown → 404.
`SBX-5` `GET/PATCH /projects/:id/warm-pool` → 200 (clamped 0-25).
`PACC-5` `POST /projects/:id/access/invite` → 201 pending; `GET/POST resend/DELETE pending-invites[/:id]` → manage; missing email → 400; unknown → 404.
`PACC-6` `GET/POST /projects/:id/group-grants` · `PATCH/DELETE /:groupId` → manage; missing group_id → 400; unknown → 404.
`BILL-10` per-seat: `POST /billing/claim-per-seat` → no-op/skipped on non-legacy.
`AUTH-1` `POST /v1/auth/logout` → OWNER 200/204; ANON 200/401.
`BILL-3b` `POST /billing/create-checkout-session` · `create-per-seat-checkout` · `create-portal-session` → Stripe URL or 400/500.
`DEL-2b` `/billing/account/*` deletion cancel lifecycle.
`SESS-11` session sub-routes (commit-push/ensure-opencode/restart/wake) → unknown/non-uuid session → 4xx (happy paths need a funded session, run on dev-api).
`SEC-5` `PUT/DELETE /projects/:id/secrets/:name/personal` → per-user secret override set/clear.
`CONN-10` `POST /executor/projects/:id/connectors/:slug/connect[/finalize]` → pipedream; unknown connector → 404/501.
`CONN-11` `POST /executor/webhook/pipedream` → public; bad/unsigned payload → rejected.
`DEL-3` `DELETE /v1/billing/account/delete-immediately` → ANON → 401 (auth boundary; destructive happy path not run).

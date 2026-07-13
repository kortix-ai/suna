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
| `M_VIEWER` `M_EDITOR` `M_MANAGER` | member + project_members row (viewer/editor/manager) | per-project (read + run-sessions) / +customize (write) / +manage. Viewer is the base *usable* role: it can read AND start/run/stop sessions (use the agent chat) — it just can't customize the project. So POST `/projects/:id/sessions` is allowed for M_VIEWER; PATCH `/projects/:id` is not |
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
`SYS-2` `GET /v1/system/status` → maintenance/banner stub. `POST /v1/prewarm` → `{success:true}`.
`SYS-3` `GET /v1/user-roles` (`supabaseAuth`) → `{isAdmin, role}` (platform role).
`SYS-4` `GET /v1/router/health` → router health (no auth).
`SYS-5` 404 shape — `GET /v1/nonexistent` → `{error:true,message:"Not found",status:404}`. Every state-changing `/v1/*` passes `auditStateChangingRequest`.
`SYS-6` `GET /v1/system/maintenance` → public read of the maintenance config (banner + maintenance page); default `{level:"none",…}`. Write is admin-only (`ADM-6`).
`SYS-7` `POST /v1/system/demo-request` → public lead capture for the marketing "book a demo" form; invalid email → 400; valid → 200 `{ok:true, emailed}` (emails `DEMO_LEAD_NOTIFY_EMAIL` via Mailtrap; `emailed:false` when Mailtrap unconfigured — graceful skip). IP rate-limited (`KORTIX_DEMO_REQUEST_REQS_PER_MIN`, 429 on flood).
`DOCS-1` `GET /v1/openapi.json` → public OpenAPI 3.1 spec (typed via `@hono/zod-openapi`). `GET /v1/docs` → public Scalar API reference (HTML).

---

## 1. GOLDEN PATH (master flow — init → ship → run → merge)

The single flow that, if green, proves the platform end-to-end. Each substep links to a section.

`GOLD-1`
1. `kortix init -y` in an empty dir → writes `kortix.yaml` + `.kortix/`, wires agent skill, `git init -b main`. No API call. (§2)
2. `kortix login --token $PAT` → `GET /accounts/me` → 200, host saved active. (§2)
3. `kortix ship -y` (no `origin` present) → managed path: `POST /projects/provision` → 201 `{push_token, repo_id, repo_url}`; `git remote add origin <freestyle>`; commit; token-header push; writes `.kortix/link.json`. (§14)
4. Poll `GET /projects/:id/snapshots` → wait for a `ready` snapshot. (§4)
5. `kortix secrets set STRIPE_API_KEY=sk_live_…` → `POST /projects/:id/secrets` → 200. (§6)
6. `kortix sessions new -p "add a README"` → `POST /projects/:id/sessions` → 201 status `provisioning`; branch `<sessionId>` created. (§7)
7. Poll `GET /projects/:id/sessions/:sid/sandbox` → status `provisioning`→`active`. (§8)
8. `POST /p/<sandboxId>/8000/session` then `POST /p/<sandboxId>/8000/session/<ocId>/prompt_async` → 204; subscribe `GET /p/<sandboxId>/8000/event` (SSE) → see message deltas; agent commits to branch. (§9)
9. `POST /projects/:id/change-requests {head_ref:<sessionId>, title}` → 201; `GET …/:crId/merge-preview` → mergeable; `POST …/:crId/merge` → 200 status `merged`. (§11)
10. `DELETE /projects/:id/sessions/:sid` → 200 status `stopped` (branch preserved). (§7)

---

## 2. CLI — local + auth (no/low API)

`INIT-1` `kortix init -y` empty dir → `kortix.yaml` + `.kortix/` (Dockerfile, `.kortix/opencode/…`, canonical skill) written, agent skill wired (codex default → `AGENTS.md`; `--primary opencode|claude|cursor` → respective skill file/symlink), `git init -b main`. **Zero API calls.** Exit 0.
`INIT-2` `kortix init` when `kortix.yaml` exists, no `--force` → exit 1 (refuses).
`INIT-3` `kortix init --primary opencode --agents claude,cursor -y` → chosen agents wired via symlinks (native dir → OpenCode config) + `AGENTS.md` for Codex/Cursor; no `.cursor` rule file; unselected agents skipped.
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

`ACC-1` `GET /access/signup-status` → 200 `{open|waitlist}`.
`ACC-2` `POST /access/check-email {email}` → 200 allowed/blocked.
`ACC-3` `POST /access/request-access {email,…}` → 200 waitlisted.
`ACC-4` (self-hosted only, `isLocal()`) `GET /setup/install-status` + `GET /setup/sandbox-providers` → public; `POST /setup/bootstrap-owner` → first owner; `GET /setup/status|health|setup-status`; `GET/POST /setup/setup-wizard-step`, `POST /setup/setup-complete`. Cloud → routes 404.

---

## 4. Accounts & identity

`ME-1` `GET /accounts/me` → 200 user + memberships. `ANON` → 401.
`ACCT-1` `GET /accounts` → list memberships (auto-claims pending invites by email).
`ACCT-2` `POST /accounts {name}` → 201 team account, caller = `owner` (`account_members` row).
`ACCT-3` `GET /accounts/:id` → member → 200; `NONMEMBER` → 403.
`ACCT-4` `PATCH /accounts/:id {name}` → `ACCOUNT_WRITE` (OWNER/ADMIN) → 200; `MEMBER` → 403.
`ACCT-5` `GET /accounts/:id/audit` → member → 200 audit log.

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
`DEL-1` `GET /account/deletion-status` → state.
`DEL-2` `POST /account/request-deletion` → schedules; `POST /account/cancel-deletion` → cancels; `DELETE /account/delete-immediately` → purges. (Mirror mount `/billing/account/*`.)

---

## 5. IAM (groups / policies / roles / super-admin)

All under `/accounts/:id/iam/*`, each route gated by its named action. Run every one as the gating role (2xx) and as `MEMBER` (403).

Group/role/policy-writing and SSO/SCIM-writing routes are ALSO gated behind `requireEntitlement` (`rbac`/`sso`/`scim` — see `IAM-32/33`): a fresh account with no billing row resolves to tier `none` (`NO_ENTERPRISE`), so `IAM-1/2/3/14/21/23/24/25/26` first `PUT …/iam/enterprise-demo {enabled:true}` on their `team()` fixture account to unlock the surface before exercising it — a real Enterprise tier would work identically, the demo toggle is just the self-serve stand-in used in-suite.

`IAM-1` `GET …/iam/groups` (`GROUP_READ`) · `POST` (`GROUP_CREATE`, `rbac`-gated) → 201.
`IAM-2` `GET/PATCH/DELETE …/iam/groups/:gid` (`GROUP_READ`/`UPDATE`/`DELETE`).
`IAM-3` `GET …/iam/groups/:gid/members` (`GROUP_READ`); `POST`/`DELETE …/members/:userId` (`GROUP_MEMBERS_MANAGE`).
`IAM-4` Effective probe: `GET …/iam/members/:userId/effective?action=…[&resourceType=&resourceId=]` (`MEMBER_READ`; self-probe always allowed) → `{allowed, reason, action, resource_type}`. Built-in account/project membership remains the default decision source; custom policies are additive and covered in `IAM-25/26`.
`IAM-5` Built-in role behavior is observable via the effective probe (`account.write` allowed for admin/owner, denied for member); the explicit action/role catalog read surface is covered in `IAM-25`.
`IAM-6` Built-in roles are immutable code-defined presets; custom role CRUD/permissions are covered in `IAM-25`.
`IAM-7` `PATCH …/iam/members/:userId/super-admin {isSuperAdmin:bool}` (`MEMBER_SUPER_ADMIN_GRANT`, OWNER only) → grant/revoke super-admin; ADMIN → 403.
`IAM-8` `GET …/iam/members/:userId/groups` · `…/effective` (`MEMBER_READ`) → effective permission set.

### Engine semantics (assert via behavior, not endpoints)
`IAM-9` **super-admin bypass** — the account creator is super-admin; their effective probe (`…/members/:userId/effective`) is `allowed:true reason:super_admin` for every action (account-write, project.create, and any project action on any/unknown project) regardless of policies or project membership. A revoked-super-admin owner still passes via `account_role`/`project_role`, never `super_admin`. Asserted via the effective endpoint.
`IAM-10` **no deny precedence** — V2 has NO deny rules (engine: "No deny precedence"; access is allow-by-role only, max-role-wins across direct+group sources). There is no constructible allow+deny conflict via real routes. Closest assertion: stack a low (viewer) direct role and a high (manager) group grant on the same project — effective `project.delete` is `allowed:true` (max wins, never denied by the lower grant). NOTE: classic deny-wins is unverifiable black-box because the feature does not exist.
`IAM-11` **PATs inherit the minter (no token-only policy eval)** — V2 has no per-token policies; a PAT carries no narrowing policy set, it only optionally binds to one project (`account_tokens.project_id`). An unscoped account PAT's effective access equals its minter's (owner → super-admin set). Asserted by exercising the same `…/effective` reads as the JWT owner. NOTE: per-token policy evaluation is unverifiable black-box because the feature does not exist; project-bound-PAT scope narrowing is covered indirectly by the token/scope flows, not here.
`IAM-12` **legacy role bridge** — `account_role` maps to the V2 action set: a plain `member` gets account-reads only — `account.read` allowed but `account.write`/`project.create` denied (`reason:account_role_insufficient`), and a project action on a project they're not on is denied (`reason:no_project_membership`), so they cannot reach all projects. owner/admin → Administrator-level set (`account.write` allowed; implicit Manager on every project). Asserted via the effective endpoint.
`IAM-13` **scope match** — a project group-grant matches only its own project. Grant a group Manager on project A; a member of that group probed with `resourceType=project&resourceId=A` → `project.delete` allowed (`reason:project_role`); the same probe against project B (no grant) → denied (`reason:no_project_membership`). Asserted via the effective endpoint with/without the matching `resourceId`.
`IAM-25` Custom roles/action catalog: `GET …/iam/actions`, `GET/POST/PATCH/DELETE …/iam/roles`, `GET/PUT …/iam/roles/:roleId/permissions`, `GET …/usage`. Invalid role key → 400; built-in role permission edit/delete → 400.
`IAM-26` Custom policies: `GET/POST/PATCH/DELETE …/iam/policies`, `POST …/iam/policies:bulk-delete`, `POST …/iam/policies:bulk-import`, plus `GET …/iam/agent-identities`. Built-in role policy → 400; non-member read → 403.

### Approval control-plane (project access-requests, approvals, agent/connector scoping)
The human-in-the-loop surface an agent's write/destructive tool calls gate on, plus its adjacent per-agent scoping and the Enterprise preview/import surfaces. `GET /projects/:id/approvals[/needs-input]` and `POST /projects/:id/approvals/:id` gate on plain IAM capability (`project.members.manage`/`project.read`), never a billing tier — see PR #4117 (a prior 402 regression on the per-session audit poll); these must never start 402ing.

`IAM-27` `POST /projects/:id/access-requests {message?}` (any signed-in caller; already-has-access short-circuits `{status:"already_has_access"}`) → 201 `{status:"created",request}`; re-request while pending → 200 `{status:"pending",request}`. `GET /projects/:id/access-requests` (`project.members.manage`) → 200 `{requests:[...]}` pending only; caller with no project grant → 404 (project existence hidden, not 403); unknown project → 404.
`IAM-28` `POST /projects/:id/access-requests/:rid/approve {role?}` / `.../reject` (`project.members.manage` — stricter than plain `manage`/`project.write`, so an editor without members-manage → 403) → 200 grants the project role (`ensureOrgMembership` + `grantProjectRole`) and marks the request `approved`/`rejected`; invalid `role` → 400; already-reviewed → 409; unknown request id → 404.
`IAM-29` `GET /projects/:id/approvals` (manager-only inbox of unresolved `pending_approval` executor actions) → 200 `{count,approvals}`; out-of-range `limit` → 400; non-manager with no grant → 404. `GET /projects/:id/approvals/needs-input` (`read` — any project member) → 200 `{total,sessions}`; a manager sees every session's pending count, a non-manager only their own launched sessions; non-member → 404.
`IAM-30` `POST /projects/:id/approvals/:executionId {decision:"approve"|"deny",scope?}` (manager OR the session launcher) → resolves a pending executor action atomically (TOCTOU-safe); malformed execution id → 400; invalid `decision` → 400 (validated before the row lookup); unknown execution id → 404; already-resolved → 409 (happy-path resolve of a REAL pending row needs a live governed connector call from an agent session — not black-box reproducible here, same constraint as `SESS-11`).
`IAM-31` `PUT /projects/:id/agents/:agentName/scope {env?,connectors?}` (`manage`) — writes the `[[agents]].env`/`.connectors` allowlists into `kortix.yaml` (or legacy `kortix.toml`); empty body (`nothing_to_update`) → 400; malformed grant set → 400; unknown agent name → 404 (`agent_not_found`); caller with no project grant → 404.
`IAM-32` `GET/PUT /accounts/:id/iam/enterprise-demo {enabled}` (`account.read`/`account.write`; deliberately NOT behind `requireEntitlement` — self-serve preview of the Enterprise surface, fail-closed/default-off) → 200 `{enabled}`; non-boolean → 400; NONMEMBER → 403.
`IAM-33` `POST /accounts/:id/iam/sso/provider/from-metadata {metadata_xml|metadata_url,name,primary_domain,domains?}` (`account.write` + `sso` entitlement) — self-serve SAML IdP registration via the Supabase auth admin API; non-Enterprise account → 402 `{code:"entitlement_required",entitlement:"sso"}` (enabling `enterprise-demo` above unlocks it for the same account); missing name/invalid domain → 400; neither `metadata_xml` nor `metadata_url` → 400 (or 501 if the deployment has no `SUPABASE_SERVICE_ROLE_KEY`); existing provider → 409; NONMEMBER → 403.

---

## 6. Projects — CRUD + access

DB `projects` (`status active|archived`, unique `(account_id, repo_url)`). Soft delete → `archived`.

`PROJ-1` `GET /projects` → OWNER/ADMIN: all account projects; `MEMBER`: only `project_members` grants; `NONMEMBER`: empty/own only.
`PROJ-2` `POST /projects {repo_url,name}` (BYO) → `PROJECT_CREATE` (OWNER/ADMIN) → 201, creator granted `manager`, snapshot build kicked. `MEMBER` → 403. Non-GitHub `repo_url` → 400.
`PROJ-3` `POST /projects/provision {name,provider:freestyle}` (managed) → `PROJECT_CREATE` → 201 `{push_token,repo_id,repo_url}`. Missing `FREESTYLE_API_KEY` → 503.
`PROJ-4` `POST /projects/create-repo {name,private?}` (new GitHub repo) → `PROJECT_CREATE` → 201; no account GitHub App install → 409 + `install_url`; auto-dedupes name collision.
`PROJ-5` `GET /projects/:id` → `read` → 200 (bumps `last_opened_at`); archived → 404; `NONMEMBER` → 403.
`PROJ-6` `GET /projects/:id/detail` → `read` → 200 project + parsed `kortix.yaml` (agents/skills/env) + file list.
`PROJ-7` `PATCH /projects/:id {name,default_branch,manifest_path}` → `manage` (M_MANAGER/OWNER/ADMIN) → 200; M_EDITOR/M_VIEWER → 403.
`PROJ-8` `DELETE /projects/:id` → `manage` → 200 status `archived`; M_EDITOR → 403.

### Project access (membership)
`PACC-1` `GET /projects/:id/access` → `read` → members + effective project roles.
`PACC-2` `POST /projects/:id/access/invite {email,role}` → `manage`. **Existing Kortix user → 200** — `ensureOrgMembership` auto-adds them to the org as `member` then grants the project role (account-manager target → implicit access, `project_role:null`). **Email with no Kortix account yet → 201 `{status:"invited", invite_id, invite_url, project_role}`** — an account invitation with a `bootstrap_grant` is created/merged idempotently so they land on the project at signup. Missing email / bad role → 400; non-account-member caller → 403 (`loadProjectForUser` — 404 only when the project row is missing/archived).
`PACC-3` `PUT /projects/:id/access/:userId {role}` → `manage`.
`PACC-4` `DELETE /projects/:id/access/:userId` → `manage`.
`PACC-7` `GET/POST/DELETE /projects/:id/resource-grants[/:grantId]` → manager-only per-resource scoping. **AGENT-ONLY (resource-model simplification): `agent` is the only member/department-scopable resource** — assigning an agent lets the assignee USE it and inherit its declared skills/connectors/secrets (to USE, not edit; editing needs the editor role). A POST with `resource_type=skill` or `secret` → **400** (agent-only; the guard runs before any config/DB load, so no existing resource is needed). Reading/listing/revoking pre-existing skill/secret grant rows still works (back-compat), but none can be CREATED. GET lists grantable resources (`$.resources.agents`) + existing grants. POST `resource_type=agent` with a real agent id + member/group principal → 201; unknown/invalid `resource_type` (e.g. `database`) → 400; invalid/foreign principal → 400/404; deleting unknown grant → 404.

---

## 7. Sessions (ephemeral branch + sandbox)

DB `project_sessions` (`status queued|branching|provisioning|running|stopped|failed|completed`, unique `(project_id, branch_name)`). Branch name = `session_id`.

`SESS-1` `POST /projects/:id/sessions {agent_name?,initial_prompt?,base_ref?,provider?,name?,session_id?,branch_already_created?,runtime_context?}` → `session` (any project member, **M_VIEWER included** — viewer is the base usable role) → 201 status `provisioning` (fire-and-forget sandbox). Base-ref precedence for human UI/mobile/CLI starts is explicit `base_ref` → one agreed non-expired attached-group `default_base_ref` → project `default_branch`; conflicting group defaults deterministically fall back to the project default. Automation/system starts ignore group defaults unless they pass an explicit `base_ref`. `runtime_context` is an optional non-secret scalar map (max 64 entries / 16 KiB UTF-8 JSON; lower-case semantic keys only; no credential-like keys); it is stored outside user-editable session metadata and restored into every replacement runtime as the single server-owned `KORTIX_SESSION_CONTEXT` JSON variable. Nested/oversize/reserved/credential-shaped input → 400 before session persistence or provisioning; raw env/MCP fields are unknown and rejected. MEMBER with no project grant / NONMEMBER → 403. (An invalid `provider` for an allowed caller → 400, proving the role gate passed before provider validation.)
`SESS-2` concurrency cap — Nth session over tier cap → **429** + `X-RateLimit-Limit/-Remaining` headers.
`SESS-3` CLI client-branch optimization — `kortix sessions new`: if server can't self-create branch (not managed-freestyle, not GitHub app/pat) AND local `origin` == `project.repo_url`, CLI mints uuid, `git push origin HEAD:refs/heads/<uuid>`, then posts `session_id`+`branch_already_created:true`+`base_ref`.
`SESS-4` `GET /projects/:id/sessions` → `read` → list (updatedAt desc).
`SESS-5` `GET /projects/:id/sessions/:sid` → `read` → 200; non-uuid `sid` → 400.
`SESS-6` `PATCH /projects/:id/sessions/:sid {name?,metadata?}` → `session` (any project member, M_VIEWER included); attempting `status`/`sandbox_url`/`error`/`opencode_session_id` → 400 (server-managed); any other field → 400 (not user-editable). `name` sets a sticky USER override stored in `metadata.custom_name` (NOT clobbered by the server-side OpenCode title mirror, which only writes the auto title `metadata.name` during session reads); `name:""`/null clears it. Response `name` = resolved display (`custom_name ?? metadata.name`); `custom_name` exposed separately (authoritative override or null).
`SESS-7` `DELETE /projects/:id/sessions/:sid` → `session` (then **owner or project manager** only — a viewer can stop sessions they own) → 200 soft-delete status `stopped`; **remote branch preserved**.
`SESS-8` `GET /projects/:id/sessions/:sid/sandbox` → `read` → `session_sandboxes` row; **404 while row not yet inserted** (frontend polls); then status `provisioning`→`active` with `base_url`/`external_id`.
`SESS-9` `POST /projects/:id/sessions/:sid/restart` → `session` (then **owner or project manager** only) → **202**; tears down container, revokes sandbox keys, re-provisions with rotated git/LLM/CLI tokens (status→`provisioning`); branch preserved.
`SESS-10` OpenCode title/tree mirror is server-owned: `GET /projects/:id/sessions` and `GET /projects/:id/sessions/:sid` read the sandbox's OpenCode sessions server-side and mirror `metadata.name`/`metadata.opencode_sessions`; there is no browser-write sync endpoint.
`SESS-12` `POST /projects/:id/sessions/:sid/stop` → `session` (then **owner or project manager** only) → **200** status `stopped`, sandbox paused in place (disk kept, no re-provision — same contract as an idle auto-stop); resumable via `/start`/`SESS-9`. Sandbox not `active` → 409; unsupported provider → 400.
`SESS-13` Public shares — `GET/POST /projects/:id/sessions/:sid/public-shares` and `DELETE …/public-shares/:shareId` → gated on `canManageSharing` (session owner or project manager; see `SESS-14`). POST body `{preview:{port,path?,label?},file?,mode?,expires_at?}` → 201 `{share:{share_id,session_id,project_id,resource_type,label,port,path,file_path,mode,allow_websocket,expires_at,revoked_at,created_at,updated_at,public_token,public_path,proxy_path}}` (`public_token` = `kps_<shareId no dashes>`); a blocked/out-of-range port or an invalid `expires_at` → 400. GET list → `{shares:[…]}`, **not filtered** — a revoked share stays in the list with `revoked_at` set (revoking never deletes the row). DELETE `:shareId` → 200 `{share:{…,revoked_at}}`; **no idempotency guard** — revoking an already-revoked share is 200 again, not 409; unknown `shareId` → 404; non-uuid `sid`/`shareId` → 400. The unauthenticated counterpart is `GET /p/public-share/:token` (§9, mounted public — no auth middleware at all): unknown token → 404 `Share link not found`; **revoked token → 410** `Share link revoked` (checked before the sandbox); a real token whose sandbox has no `external_id` yet → 503 `Sandbox is not ready` (`resolvePublicShare` LEFT JOINs `session_sandboxes` for exactly this case — a freshly-created, not-yet-provisioned session has no sandbox row at all; an INNER JOIN previously misread that as a 404 "not found" on a perfectly valid token); a resolvable `preview` share proxies to `GET {origin}/p/public-share/:token/:port/*` (redirect for the bare `:port` form), a `file` share to `.../file[/*]` (view-only — non-GET/HEAD/OPTIONS → 405).
`SESS-14` Public-share access gate (`loadSessionForSharing().canManageSharing = isOwner || canManageProject` — projects/lib/access.ts; **not** `loadVisibleSession()`, which gates on session-content visibility and made a manager's `canManageProject` half unreachable on the default-`private` session, 404ing before the sharing check ever ran) — the session **creator** may manage its shares regardless of project role; a project **manager** (or owner/admin) may manage ANY session's shares even if they didn't create it; a project **editor/viewer who is not the creator** → 403 (`"Only the session owner or a project manager can …"`, a real permission denial — they're a legitimate project member, so there's nothing to 404-hide); NONMEMBER → 403 (account-membership gate, before the sharing check); ANON → 401.
`SESS-15` `GET /projects/:id/sessions/:sid/audit` → `read` + session-visible → 200 `{session_id,agent,audit_access,count,actions:[{execution_id,action,connector_id,status,risk,acted_by,acted_by_email,resolved_by,resolved_by_email,result_summary,at,resolved_at}]}` (most-recent-first, `?limit=` 1–1000, default 200; invalid `limit` → 400). This is the always-on approval control plane the launcher polls from every open session — non-Enterprise accounts (`auditAccess` entitlement off) degrade to **unresolved pending approvals only**, never a 402. Non-uuid `sid` → 400; NONMEMBER → 403; ANON → 401.
`SESS-16` Anonymous session-share VIEWING — `GET /public/session-shares/:shareId` and `GET /public/session-shares/:shareId/messages` (mounted public, `apps/api/src/public-session-shares/`; rate-limited by share id via `createPublicSessionShareRateLimitMiddleware`). `:shareId` is the SESS-13 share's raw `share_id` (uuid), NOT the `kps_` token — the route derives the token server-side (`publicShareToken(shareId)`) and resolves through the same `resolvePublicShare()` (identical 404/410/503 semantics; ANY existing share resourceType, `preview` or `file`, unlocks the view). `GET /:shareId` → 200 `{share:{share_id,session_id,project_id,resource_type,label,sandbox_status,expires_at},session:{session_id,title,status,created_at,updated_at}}`; DB-only, no sandbox round-trip. `GET /:shareId/messages` → 200 `{available,reason,opencode_session_id,message_count,messages:[{role,created,completed,text,tools:[{tool,status}],files:[{filename,mime}],reasoning_omitted}]}` — a sanitized, text-only digest fetched server-to-sandbox (no client-side sandbox access); 503 `"Sandbox is not running"` when the session's sandbox row isn't `active`, otherwise degrades to `available:false` (still 200) for a transient not-ready OpenCode daemon rather than erroring. Non-uuid `shareId` → 400.

---

## 8. Sandbox lifecycle + snapshots

`SNAP-1` `GET /projects/:id/snapshots` → `read` → list `kortix-snap-…` images per baseRef. **Session boot requires a `ready` snapshot of baseRef** (no shared fallback → session `failed` if none).
`SNAP-2` `POST /projects/:id/snapshots/rebuild` → **`manage` AND account `ACCOUNT_WRITE` (owner/admin)** → rebuild image. A project `manager` who is not owner/admin → 403; M_EDITOR → 403.
`SBX-1` sandbox create/start = implicit on session create (`provisionSessionSandbox`); no standalone endpoint.
`SBX-2` sandbox manual stop = `SESS-12` (pauses in place, resumable); destructive teardown = session `DELETE` (`SESS-7`); restart = `SESS-9`; status read = `SESS-8`.

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

---

## 10. Files (read via git API; write via sandbox)

Repo files are read-only over the project API; live edits happen in the sandbox (OpenCode file API via proxy) or via manifest commits. All git reads are `read`.

`FILE-1` `GET /projects/:id/files?ref=&path=` → file/dir listing.
`FILE-2` `GET /projects/:id/files/content?path=&ref=` → file text; **absent `path` param → 400**; non-existent file path is uncaught → surfaces 500 (not 404).
`FILE-3` `GET /projects/:id/files/search?q=&content=1&ref=&limit=` → filename + grep.
`FILE-4` `GET /projects/:id/files/history?path=` → commit history for path.
`FILE-5` `GET /projects/:id/files/archive?path=&ref=` → zip stream.
`FILE-6` `GET /projects/:id/branches` → branches plus the caller's effective `session_default_ref`, source/group metadata, and conflict fallback signal.
`FILE-7` `GET /projects/:id/commits?ref=&path=` · `GET …/commits/:sha` · `GET …/commits/:sha/diff`.
`FILE-8` `GET /projects/:id/version-diff?from=|head=&into=|base=` → diff between two refs (params are `from`/`head` and `into`/`base` — there is **no `to`**).
`FILE-9` live file CRUD inside sandbox → through proxy to OpenCode file API on `:8000` (create/read/update/delete/list). Durable truth = git repo; sandbox tree is ephemeral.

---

## 11. Change Requests (mandatory path to land branch work on main)

DB `change_requests` (per-project `number`, `status open|merged|closed`).

`CR-1` `GET /projects/:id/change-requests?status=open|merged|closed|all` → `read`.
`CR-2` `POST /projects/:id/change-requests {title,head_ref,base_ref?,description?,session_id?}` → `write` → 201, head/base SHAs anchored. Missing `title` → 400; missing `head_ref` → 400; `base_ref==head_ref` → 400; head with no commits ahead of base (equal tip, or merge-base == head behind an advanced base) → 422 `CR_HEAD_NOT_AHEAD` — an empty CR can never be created (the resolver force-refreshes the mirror before rejecting, so a just-pushed head never bounces).
`CR-3` `GET …/:crId` → `read` (auto-refreshes branch tips).
`CR-4` `PATCH …/:crId` → `write`, open only.
`CR-5` `GET …/:crId/diff` → `read` → file list + unified patch.
`CR-6` `GET …/:crId/merge-preview` → `read` → mergeable / fast-forward / conflicts.
`CR-7` `POST …/:crId/merge {message?}` → **`write` required** → 200 status `merged` + sha; not-open → 409.
`CR-8` `POST …/:crId/close` · `POST …/:crId/reopen` → `write`.
`CR-8b` `POST …/:crId/request-changes {feedback}` → **`write` required** → 200 `{change_request, delivering}` — persists the note under CR metadata `requested_changes` + delivers it to the origin session's agent (Review Center "request changes"). Missing `feedback` → 400; not-open → 409.
`CR-9` CLI mirror: `kortix cr ls|show|diff|open|merge|close|reopen` (reads `KORTIX_PROJECT_ID` inside sandbox).
`CR-10` response envelopes (assert shape): list → `{change_requests:[…]}`, get → `{change_request:{…}}`, merge → `{change_request, merge}`. (Project DELETE returns `{ok:true}`, not an echoed status.)

---

## 11b. Review Center (per-project human-in-the-loop inbox)

DB `review_items` (per-project; `kind change|approval|output|decision|batch`, `status needs_you|waiting|approved|changes_requested|rejected|done|dismissed`, polymorphic `detail` jsonb). This pass: native items only (`output|decision|batch` via submit); `change`/`approval` are folded in by adapters later.

`RV-1` `GET /projects/:id/review/items?segment=needs_you|waiting|done&kind=…` → `read` → `{review_items:[…]}`. Invalid `segment` → 400; invalid `kind` → 400.
`RV-2` `GET …/review/items/:reviewItemId` → `read` → `{review_item:{…}}`; unknown id → 404.
`RV-3` `POST …/review/items {kind(output|decision|batch),title,summary?,risk?,detail?,agent?,session_id?}` → `read` + agent scope `project.review.submit` → 201. Missing `title` → 400; non-submittable `kind` (e.g. `change`) → 400; invalid `risk` → 400.
`RV-4` `POST …/review/items/:reviewItemId/act {verdict(approve|reject|changes|answer|dismiss),feedback?}` → `write` + `project.review.act` → 200 updated item; invalid `verdict` → 400; unknown id → 404; adapted (`cr:…`) id → 409 (act from the source view). The list read-model also folds in Change Requests as `kind:change` items (id `cr:<crId>`).
`RV-5` `POST …/review/bulk {ids:[…],verdict}` → `write` + `project.review.act` → 200 `{updated,review_items}`; empty/missing `ids` → 400.
`RV-6` access: NONMEMBER list → 403/404; ANON list → 401.

---

## 12. Triggers (cron + webhook; source of truth = `kortix.yaml`)

Specs in `[[triggers]]`; CRUD commits the manifest; runtime `last_fired_at` in `project_trigger_runtime`. Types: `cron`, `webhook` only.

`TRG-1` `GET /projects/:id/triggers` → `read` + leaf `project.trigger.read` → specs + `last_fired_at` + parse `errors` + `webhook_url`; non-member 403/404; ANON 401.
`TRG-2` `POST /projects/:id/triggers {name(required),slug?,type,agent?,enabled?,prompt_template,cron?,timezone?,secret_env?}` → `manage` → 201, manifest committed; `name` is required (slug derived from it when omitted); duplicate slug → 409. `webhook` requires `secret_env` (names a `project_secrets` key, regex `^[A-Z_][A-Z0-9_]*$`). `cron` requires 6-field croner expr + IANA `timezone` (default UTC).
`TRG-3` `PATCH /projects/:id/triggers/:slug` (e.g. `{enabled:false}`) → `manage`.
`TRG-4` `DELETE /projects/:id/triggers/:slug` → `manage` (also drops runtime row).
`TRG-5` `POST /projects/:id/triggers/:slug/fire` → `manage` → manual fire → 202 `{status:fired,session_id}`; under backpressure → 202 `{status:queued,reason}`.
`TRG-6` cron scheduler — global `setInterval` (default 60s), sweeps ≤200 active projects; due = `nextCronRun(cron,lastFired,tz) ≤ now`; **marks fired BEFORE firing** (no double-spawn per slot). Disabled via `KORTIX_TRIGGER_SCHEDULER_ENABLED=false`.
`TRG-7` webhook fire — `POST /webhooks/projects/:id/:slug` (**public, HMAC**). Sig header `X-Kortix-Signature` or `X-Hub-Signature-256` (`sha256=` stripped), HMAC-SHA256 over raw body vs `project_secrets[secret_env]`, constant-time. Valid → 202 fired/queued; malformed UUID/slug → 400; unknown project → 404; bad sig → 401; missing secret → 409; unknown/disabled/non-webhook trigger → 404; fire failure → 500.
`TRG-8` fire→run — `fireGitTrigger` → actor = account's first `owner` (no owner → silent fail), `createProjectSession(enforceAccountCap:false, visibility:'project', metadata.trigger_*)` — trigger sessions are project-visible (any project member sees them in `GET /sessions`), not private to the stand-in actor. Backpressure: provisioning sessions ≥3 OR account at tier cap → queued.
`TRG-9` **No inbound GitHub event webhook exists.** Simulate "GitHub Actions"-style automation as a generic `webhook` trigger; a GitHub repo webhook can drive it if its secret == `secret_env` (via `X-Hub-Signature-256`).
`TRG-10` `GET /projects/:id/triggers` leaf gate — a member bound to a custom (Enterprise) project role granting `project.read` but NOT `project.trigger.read` loads the project yet is rejected 403 at `GET /triggers` (the `assertProjectCapability(project.trigger.read)` fires after the read passes); a floor `user` member (built-in role carries `project.trigger.read`) still gets 200. Scoped-agent-token variant proven at the API layer in `integration-project-read-leaf-gates-http.test.ts`.

---

## 13. Channels (Slack / Telegram / Email)

Tokens stored as encrypted project secrets; webhooks public + signature-gated.

`CHN-1` `kortix channels connect --bot-token xoxb-… --signing-secret …` (manual/BYO mode) → validates `xoxb-` via `auth.test` → `POST /projects/:id/channels/slack/connect` (`manage`) → 200, prints webhook `$API/webhooks/slack/:id`.
`CHN-1b` `kortix channels connect` (no creds) → `GET /projects/:id/channels/slack/mode` (`read`) → `{oauth_available, install_url}`; when available the CLI prints the pre-signed one-click "Add to Slack" URL (signed `state`, 10-min TTL — same flow as CHN-7) instead of manual mode.
`CHN-2` `GET /projects/:id/channels/slack/installation` → `read` → workspace/team/bot/url or "not connected".
`CHN-3` `DELETE /projects/:id/channels/slack/installation` → `manage`.
`CHN-4` Slack inbound (OAuth mode) — `POST /webhooks/slack` (shared `SLACK_SIGNING_SECRET`): `v0=HMAC(v0:{ts}:{body})`, ±5min replay window; `url_verification` → echo `challenge`; `event_callback` routed by `team_id`→binding→project.
`CHN-5` Slack inbound (BYO mode) — `POST /webhooks/slack/:id` (per-project signing secret).
`CHN-6` Slack dispatch — `app_mention`/IM/threaded `message` → existing thread session → deliver to sandbox `/kortix/prompt` (`delivered|transient|stale`); else `createProjectSession` (actor=owner, agent `default`, `visibility:'project'` — channel sessions are team-visible) + record `chat_threads`.
`CHN-7` Slack OAuth — `GET /webhooks/slack/oauth/callback` (signed `state`, 10-min TTL) → exchange code → `saveSlackInstall`.
`CHN-8` Telegram inbound — `POST /webhooks/telegram/:id`: verify `x-telegram-bot-api-secret-token` (missing→404, mismatch→401) → dedupe `update_id` (Telegram redelivers) → group etiquette (groups answer only when @-mentioned/replied-to/commanded) → `/start`/`/help`/`/new` answered server-side → else route to a session: `chat_threads` (platform `telegram`, botId, chatId) continuity with the single-winner create claim; binding (`chat_channel_bindings`) supplies agent/model/conversation-policy and is auto-registered on first contact; visibility follows the policy (default `project`).
`CHN-9` bad sig on any channel webhook → 401. Not configured → **503 (Slack OAuth mode + OAuth callback)** but **404 (Slack BYO + Telegram)**.
`CHN-13` `POST /projects/:id/channels/email/connect {connector_slug?}` → `manage` + project experimental `agentmail_email` enabled → creates or attaches an AgentMail inbox + `message.received`/`message.received.unauthenticated` webhook, stores inbox/webhook metadata as encrypted per-profile project secrets, and marks that Email connector profile connected. Disabled projects return 403 before AgentMail key validation. Omit `connector_slug` for legacy `kortix_email`; provide an Email connector slug for multiple inboxes.
`CHN-14` `GET /projects/:id/channels/email/installation?connector_slug=...` → `read` → AgentMail inbox id/email/webhook id for that profile or null; disabled projects return null.
`CHN-15` `DELETE /projects/:id/channels/email/installation?connector_slug=...` → `manage` → removes that profile's inbox binding.
`CHN-16` AgentMail inbound — `POST /webhooks/email/agentmail`: Svix `svix-*` signature verified against the per-project webhook secret when configured; AgentMail's real unwrapped `message.received` or `message.received.unauthenticated` payload routes by `message.inbox_id` → project, maps `thread_id` 1:1 to a Kortix session, and follow-up emails continue that session.
`CHN-17` `GET /projects/:id/channels/email/mode` → `read` → `{provider:"agentmail",enabled:boolean,managed_available:boolean}` so the UI can hide Email until `agentmail_email` is enabled and require a project AgentMail key when no managed server key exists.
`CHN-18` `GET /projects/:id/channels/bindings` → `read` → `{projectDefaultAgent, bindings:[{bindingId,platform,workspaceId,channelId,channelName,channelType,agentName,opencodeModel,conversationPolicy,installedAt,effectiveAgent:{agent,source}}]}` — the web management surface for `chat_channel_bindings` (today populated only via Slack `/kortix agent|model|policy`); `effectiveAgent` resolves `agentName ?? project default ?? 'default'` the same way the Slack panel does.
`CHN-19` `PATCH /projects/:id/channels/bindings/:bindingId {agentName?,opencodeModel?,conversationPolicy?}` → `project.connector.write` (no dedicated channel-binding leaf exists; reuses the same capability that gates connecting/disconnecting the channel itself) → updates via the same `setChannelAgent`/`setChannelModel`/`setChannelConversationPolicy` helpers the Slack commands call; `agentName` validated against the project's declared `[[agents]]` when adopted (any name accepted for a legacy/undeclared project), `null` resets to the project default, `"default"` is an alias for `null`; `opencodeModel` validated via `isModelServableForAccount` (409 `model_not_servable` when not servable) and normalized to the opencode `kortix/…` ref before storing; unknown `bindingId` → 404; empty body → 400 `empty_patch`.
`CHN-20` send-primitive IAM gate — `POST /projects/:id/channels/slack/file/upload` and `POST /projects/:id/channels/meet/speak` both post to a channel with the project's bot credentials and now assert leaf `project.connector.write` (IAM enforcement audit; previously gated by project-read only, so any read-capable caller could drive them). A floor `user` member (project.read, no connector.write) → 403 before any Slack/ElevenLabs call; an `editor` (holds connector.write) passes the gate (200/400/404/502/503, never 403); non-member 403/404; ANON 401. The `channel.*` catalog leaves were removed (never wired to a route). Scoped-agent-token variant proven at the API layer in `integration-project-read-leaf-gates-http.test.ts`.
`CHN-21` `GET /projects/:id/channels/telegram/installation` → `read` → `{botId,botUsername,installedAt,allowedUserIds,pairingRequired}` or null (`allowedUserIds` = the sender allowlist from `projects.metadata.telegram`, `pairingRequired` = the `TELEGRAM_REQUIRE_USER_IDENTITY` gate, default on). Telegram is an OPTIONAL channel — nothing else depends on it being connected.
`CHN-22` `POST /projects/:id/channels/telegram/connect {bot_token}` → `manage` + `project.connector.write` → token shape checked LOCALLY (400 before any Telegram call) → `getMe` validate (Telegram rejects → 400; unreachable → 502) → mint webhook secret + server-side `setWebhook` (+ `setMyCommands` best-effort) → encrypted secrets + `chat_installs` (workspaceId = bot id) → response includes the first `pairing {code,expiresAt}` (CHN-25). The token never appears in any response, sandbox env, or CLI.
`CHN-23` `DELETE /projects/:id/channels/telegram/installation` → `manage` + `project.connector.write` → best-effort `deleteWebhook`, purge secrets + install row; idempotent `{status:"disconnected"}`.
`CHN-24` Telegram file proxy (send/read/file surface) — `GET /projects/:id/channels/telegram/file?file_id` (`read`) resolves getFile + streams bytes with the token server-side (validated `file_path`, 25MB cap); `POST /projects/:id/channels/telegram/file/upload` (`read` + `project.connector.write` — send primitive, CHN-20 precedent) multipart-sends a sandbox file (50MB cap). Both fail CLOSED without an install (404 before any outbound call). The send/read/file MECHANICS (token-in-path gateway isolation, catalog, chunked reply relay, path validation) are pinned by API unit tests (`telegram-connector.test.ts`, `channels/telegram/*.test.ts`) — live suites have no real bot.
`CHN-25` Telegram sender pairing — `POST /projects/:id/channels/telegram/pairing-code` (`manage` + `project.connector.write`; 404 without an install) mints a single-use 15-min `{code,expiresAt}` (XXXX-XXXX, stored encrypted, replaces any outstanding code). The user sends `/start <code>` to the bot (deep-linkable `t.me/<bot>?start=<code>`); the webhook constant-time-matches + expiry-checks it, allowlists the sender id in `projects.metadata.telegram.allowedUserIds`, and clears the code BEFORE acking (no replay). Wrong/expired/missing codes get one generic failure text. Unpaired senders in private chats get a pairing hint (dedup-throttled) instead of silence; the gate itself is CHN-8's allowlist check. Pairing-code mechanics pinned by unit tests (`channels/telegram/pairing.test.ts`).
`CHN-26` `DELETE /projects/:id/channels/telegram/allowed-users/:userId` → `manage` + `project.connector.write` → removes the id from the allowlist (`{removed:bool}`); metadata-only, works without an install; unknown id → `{removed:false}`.

### Meetings (Recall.ai notetaker bot) — §MEET

A meeting-notetaker bot (Recall.ai) joins Google Meet / Zoom / Teams calls via the `meet` channel CLI. The bot transcribes, answers when addressed (chat or voice via ElevenLabs), and auto-recaps when the call ends. Per-project voice + bot name live in `projects.metadata.meet`. Gated platform-wide by `MEET_ENABLED` and per-project by the `meet` experimental flag.

`MEET-1` `GET /projects/:id/channels/meet/voices` → `read` → `{selected, bot_name, default_bot_name, speak_enabled, voices[]}` (ElevenLabs catalog + chosen voice/name; `speak_enabled` reflects whether an ElevenLabs key is configured).
`MEET-2` `PUT /projects/:id/channels/meet/voice {voice}` → `manage` → sets the bot's TTS voice; unknown voice → 400.
`MEET-3` `PUT /projects/:id/channels/meet/name {name}` → `manage` → sets the bot's display name (default "Kortix Notetaker"); its first word becomes the wake word.
`MEET-4` `POST /projects/:id/channels/meet/voices/:voiceId/preview` → `read` → base64 MP3 sample in that voice; unknown voice → 400; no ElevenLabs key → 503.
`MEET-5` `POST /projects/:id/channels/meet/speak {bot_id,text,voice?}` → leaf `project.connector.write` (send primitive — IAM enforcement audit; was project-read only) → ElevenLabs TTS → Recall `output_audio` (the bot speaks aloud); missing `bot_id`/`text` → 400. Gate coverage in CHN-20.
`MEET-6` Recall realtime relay — `POST /webhooks/meet/realtime`: public; verifies the HMAC session token in `bot.metadata` (bad/missing → 401); wake-gated transcript/chat → live session; the bot's own transcribed speech is echo-suppressed.
`MEET-7` Recall lifecycle — `POST /webhooks/meet/status`: public; on `bot.done` (verified via the `bot.metadata` token; bad/missing → 401) auto-wakes the session to produce the recap (TL;DR + decisions + action items).

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
`SHIP-2` first ship, existing `origin` → **BYO** (single-writable-origin rule): `POST /projects {repo_url,name}`, **origin never modified**, push with user's own creds. **NB: the API's BYO `POST /projects` only accepts a GitHub repo_url** (`normalizeRepoUrl`→`resolveGitHubImport`); a non-GitHub origin is rejected 400 before `saveLink`, so ship exits non-zero, writes no link.json, and (proven) never clobbers the origin. The real happy path needs a live GitHub repo + App install.
`SHIP-3` first ship `--origin <git-url>` → BYO explicit; only this case rewrites `origin` (`git remote set-url`) — but `setOrigin` runs *after* the POST, so a non-GitHub `--origin` 400s first → non-zero exit, no link.json, origin not rewritten (GitHub-only, as SHIP-2).
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
`SEC-6` `POST /projects/:id/secrets {identifier,name,value}` → two identifiers may share one env-var `name` (e.g. `GMAPS-primary`/`GMAPS-backup` both `GOOGLE_MAPS_API_KEY`); re-submitting an existing `identifier` with a different `name` → 409.

---

## 16. Billing (gated by `KORTIX_BILLING_INTERNAL_ENABLED`; off → 404 `billing_disabled`)

`BILL-1` `GET /billing/account-state` (always available; off → unlimited mock) · `GET …/account-state/minimal`.
`BILL-2` `POST /billing/create-checkout-session {server_type,location,...}` → Stripe checkout for a server-type plan (the `/billing/setup/initialize` route in older drafts never shipped; `server_type`/`location` are body fields on create-checkout-session — `billing/routes/subscriptions.ts`). ANON → 401; non-member → 403.
`BILL-3` `POST /billing/create-checkout-session` · `create-inline-checkout` · `confirm-inline-checkout` · `create-portal-session`.
`BILL-4` `POST /billing/cancel-subscription` · `reactivate-subscription` · `schedule-downgrade` · `cancel-scheduled-change` · `sync-subscription`; `GET /billing/proration-preview`.
`BILL-5` `POST /billing/purchase-credits`; `GET /billing/transactions[/summary]`, `credit-usage`, `tier-configurations`, `credit-breakdown`, `usage-history`; `GET /billing/checkout-session/:sessionId` · `POST /billing/confirm-checkout-session`.
`BILL-6` auto-topup: `GET …/auto-topup/settings|setup-status` · `POST …/auto-topup/configure`. Cron: `POST /billing/cron/yearly-rotation`.
`BILL-7` `POST /billing/deduct {prompt_tokens,completion_tokens,model}` · `POST /billing/deduct-usage {amount,description}` (agent runtime).
`BILL-8` `POST /billing/webhooks/stripe` (also `/webhook/stripe`) — Stripe sig: missing sig → 400, misconfigured secret → 500. `POST /billing/webhooks/revenuecat` — **Bearer-token auth, bad → 401** (not an in-body sig). Both public, no auth middleware.
`BILL-9` billing write ops (`create-checkout-session`/`create-per-seat-checkout`/`create-inline-checkout`/`confirm-inline-checkout`/`create-portal-session`/`claim-per-seat`/`cancel-subscription`/`reactivate-subscription`/`schedule-downgrade`/`cancel-scheduled-change`/`purchase-credits`/`auto-topup/configure`) — auth boundary: ANON → 401; non-account-member → 403; account `MEMBER` (`billing.read` only) → 403. They require `billing.write` (OWNER + the `billing_manager` BILLING policy only; ADMIN/AUDITOR/MEMBER denied), enforced by `billing/require-billing-write.ts` (`resolveScopedAccountId` membership check + `assertAuthorized(billing.write)`) — so a non-billing teammate can't subscribe / cancel / top-up on the account's behalf. Reconcile/read ops (`sync-subscription`, `sync-seat-quantity`, `proration-preview`, `checkout-session/:id`, `confirm-checkout-session`) stay member-accessible (membership only). **(finding 2026-06-04 RESOLVED 2026-06-11: the `billing.write` gate now exists in code; the earlier "any member passes" gap is closed.)**

---

## 17. Router / LLM / proxy (sandbox-facing; `apiKeyAuth`)

`RTR-1` `POST /router/web-search {query}` · `POST /router/image-search` → `APIKEY` → 200; `ANON`/JWT → 401.
`RTR-2` `POST /router/chat/completions {model,messages,stream}` (OpenAI-compat) · `GET /router/models` · `GET /router/models/:model` · `POST /router/messages` (Anthropic-style).
`RTR-4` billed proxy passthrough `ALL /router/:service[/*]` for `tavily|serper|firecrawl|replicate|context7|anthropic|openai|xai|gemini|groq` — Kortix token → managed keys; user key + `X-Kortix-Token` → passthrough; disallowed service/route → 4xx.

---

## 18. Platform / OAuth2 provider / Tunnel / Servers / Deployments

### Platform API keys
`PLT-1` `GET /platform/` → `{ok:true,message:"platform"}` (public). `GET /platform/sandbox/version[/latest|/all|/changelog]` (public).
`PLT-2` **sandbox-scoped** API keys (`platform/routes/api-keys.ts`): `GET/POST /platform/api-keys` (sandbox_id required — query for GET, body for POST; `requireSandboxAccess`) · `PATCH /platform/api-keys/:keyId/revoke` · `DELETE /platform/api-keys/:keyId` · `POST …/:keyId/regenerate` (`type:'sandbox'` keys only) (`supabaseAuth`). ANON → 401; missing/non-UUID sandbox_id → 400; unknown sandbox → 404; unknown keyId → 404. (Not account-level keys — every route hinges on a sandbox.)

### OAuth2 provider (Kortix as IdP for CLI/MCP/tunnel)
`OAU-1` `GET /oauth/authorize` (public) → redirect to consent.
`OAU-2` `GET /oauth/authorize/consent/:requestId` (auth) → consent data; `POST /oauth/authorize/consent` → submit.
`OAU-3` `POST /oauth/token` (public, **form-encoded**) — requires `grant_type` ∈ {`authorization_code`,`refresh_token`} (others → `unsupported_grant_type`) + `client_id`+`client_secret` (missing → 400, bad → 401 `invalid_client`).
`OAU-4` `GET /oauth/userinfo` · `GET /oauth/claimable-machines` (`oauthTokenAuth`; `oauthTokenAuth` is local to `oauth/index.ts`, not a shared middleware). claimable-machines queries legacy `sandboxes` (`provider:justavps`) → empty on Daytona-only deploys.

### Tunnel (reverse tunnel to local machines)
`TUN-1` connections `GET/POST /tunnel/connections`, `GET/PATCH /:tid`, `POST /:tid/rotate-token`, `DELETE /:tid`.
`TUN-2` permissions `GET/POST /tunnel/permissions/:tid`, `DELETE /:tid/:permissionId`; requests `GET /tunnel/permission-requests`, `GET …/stream` (SSE), `POST /:rid/approve|deny`.
`TUN-3` rpc `POST /tunnel/rpc/:tid`; audit `GET /tunnel/audit/:tid`.
`TUN-4` device auth (public) `POST /tunnel/device-auth`, `GET …/:code/status`; (auth) `GET …/:code/info`, `POST …/:code/approve|deny`.
`TUN-5` WS `GET /tunnel/ws?tunnelId=` — auth via first message; rate-limited.

### Servers (MCP registry)
`SRV-1` `PUT /servers/sync` · `GET/POST /servers` · `GET/PUT/DELETE /servers/:id` (`combinedAuth`).

### Deployments (gated `KORTIX_DEPLOYMENTS_ENABLED`)
`DEP-1` `POST /deployments` · `GET /deployments[/:id]` · `POST /:id/stop|redeploy` · `DELETE /:id` · `GET /:id/logs` (`combinedAuth`).

### Apps (experimental `KORTIX_APPS_EXPERIMENTAL`, `[[apps]]` in manifest)
`APP-1` `GET /projects/:id/apps` (`read`) · `POST` (`manage`) · `PATCH/DELETE /:slug` (`manage`) · `POST /:slug/deploy|stop` (`manage`) · `GET /:slug/logs` (`read`).

### Ops (platform admin)
`OPS-1` `GET /ops/overview` → `requireAdmin` (platform admin/super_admin) → 200; non-admin → 403.

### Admin console API (platform admin)
The `/v1/admin/api/*` surface backs `apps/web/src/app/admin/` — all guarded by `supabaseAuth` + `requireAdmin` (platform admin/super_admin): ANON → 401, authed non-admin → 403. The 200 happy paths run when a platform-admin token is provided (`KE2E_ADMIN_TOKEN`, capability `admin`).
`ADM-1` `GET /v1/admin/api/accounts` → paged account list (search/tier/balance filters) → 200; non-admin → 403.
`ADM-2` `GET /v1/admin/api/accounts/:id/users` → the account's member users → 200; non-admin → 403.
`ADM-3` `GET /v1/admin/api/accounts/:id/ledger` → the account's credit ledger → 200; non-admin → 403.
`ADM-4` `POST /v1/admin/api/accounts/:id/credits {amount,description?,isExpiring?}` → grant credits → 200 `{ok:true,balance}`; non-positive amount → 400; non-admin → 403.
`ADM-5` `POST /v1/admin/api/accounts/:id/credits/debit {amount,description?}` → debit credits → 200 `{ok:true,balance}`; non-positive amount → 400; non-admin → 403.
`ADM-6` `PUT /v1/system/maintenance` (`supabaseAuth`, handler does admin check) → update maintenance config → 200; non-admin → 403; ANON → 401.

---

## 19. Cross-cutting boundary / negative matrix

Run these against representative endpoints from each domain.

`SEC-A` `ANON` (no header) on any protected route → 401.
`SEC-B` malformed/expired JWT → 401; revoked PAT/api-key → 401.
`SEC-C` `NONMEMBER` on `GET/PATCH/DELETE /accounts/:id`, `/projects/:id` → 403/404.
`SEC-D` project-scoped PAT: allowed only on its bound project + `/accounts/me`; **every other surface → 403** (cross-project, `/accounts/*`, project-list, router/billing/channels/etc.).
`SEC-E` 404 shape — `GET /v1/nonexistent` → `{error:true,message:"Not found",status:404}`.
`SEC-F` webhook sig bypass — Stripe/RevenueCat/Slack/Telegram/project-webhook with missing/wrong sig → 400/401.
`SEC-G` preview proxy without token/cookie → 401; cross-sandbox token reuse → 403.
`SEC-H` audit — every state-changing `/v1/*` writes an audit row (`auditStateChangingRequest`); assert `GET /accounts/:id/audit` reflects a prior mutation.
`SEC-I` rate limits — session create (429), invite-accept, preview proxy, tunnel WS each return their limiter response under load.

### Role × project-action grid (assert per row)

| Action level | OWNER | ADMIN | M_MANAGER | M_EDITOR | M_VIEWER | MEMBER (no grant) | NONMEMBER |
|---|---|---|---|---|---|---|---|
| `read` (GET project/files/sessions) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 |
| `session` (create/PATCH/DELETE/restart session — use the chat) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 |
| `write` (PATCH project, CR merge, deploy, triggers) | ✓ | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 | ✗ 403 |
| `manage` (DELETE project, secrets, members/access) | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 |

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
- sandbox (session_sandboxes): `provisioning | active | stopped | error | archived`
- snapshot: `queued | building | ready | failed` (session boot needs a `ready` snapshot of baseRef)
- change request: `open | merged | closed`
- trigger fire result: `fired | queued | failed`

## 21. Known gaps (don't write tests for these — they don't exist)

- No account-level vault — secrets are project-scoped, all-or-nothing per project (the `vault_items`/per-member-scope design was reversed).
- Granular IAM actions `project.trigger.*`, `channel.*`, `trigger.*` exist in the catalog but those project routes only enforce coarse `read|write|manage` — test the coarse gate, not the fine actions. **Exception:** session lifecycle routes (create/PATCH/DELETE/restart) now enforce `project.session.start` via the `session` access tier, which every project role (viewer included) holds — so a viewer CAN run sessions but still can't `write`/`manage`.
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
- **API (Bun):** the working path is **in-process** — implement curl flows as a `bun test` driver that imports the *real* app and calls `app.fetch(new Request(...))`, not the stub `createTestApp()` in `apps/api/src/__tests__/helpers.ts` (it mounts only a handful of routes and bypasses the monolith). The real app is exported at `apps/api/src/index.ts` (`export default { fetch }`). Then:
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
**Uncovered ≠ dead.** The e2e suite legitimately won't hit error branches, the cron scheduler, the queue drainer, webhook handlers, or rarely-used ops routes — those are live in prod. Only static analysis (A) can claim "never imported." **Dead-code candidate = flagged by knip (A) AND uncovered by the suite (B).** Uncovered-but-imported = "untested," not dead.

### Smallest first step
1. `pnpm add -Dw knip && pnpm exec knip` → the true dead-code list, today.
2. Refactor a couple `apps/api/src/__tests__/e2e-*.test.ts` to drive the real `index.ts` export in-process, run `bun test --coverage` → prove the function-level lcov pipeline on the real app.
3. Add Playwright+monocart for web; merge all lcov into one HTML report; diff against knip.

---

## 24. Connectors (executor)

`CONN-1` `GET /executor/connectors` → executor-principal (sandbox KORTIX_TOKEN) route; user JWT + `ANON` → 401 (200 path exercised in-sandbox).
`CONN-2` `GET /executor/projects/:id/connectors` → project admin → 200; `NONMEMBER` → 403.
`CONN-3` `POST /executor/call {connector,action,args}` → executor-principal route; user JWT + `ANON` → 401.
`CONN-4` `POST /executor/projects/:id/connectors/sync` → admin → 200 (re-materialize from kortix.yaml).
`CONN-5` `GET /executor/projects/:id/policies` → admin → 200; `PUT …/policies {policies[]}` → admin → 200.
`CONN-7` `PUT /executor/projects/:id/connectors/:slug/credential` → missing value → 400.
`CONN-8` `POST /executor/projects/:id/connectors` → admin; invalid json → 400. `DELETE …/:slug` → admin → ok/404.
`CONN-9` `GET /executor/projects/:id/pipedream/apps` → admin → 200 or 501 (pipedream not configured).
`CONN-13` `PUT /executor/projects/:id/connectors/:slug/credential-mode|name|policies` → admin (`project.connector.write`); body validated before the connector lookup (bad mode/empty name/invalid policy action → 400 even against an unknown slug); well-formed body + unknown connector → 404; NONMEMBER → 403.

**Connector authorization is centralized on the AGENT (2026-07-06).** `PUT /executor/projects/:id/connectors/:slug/sharing` and `PUT …/agent-scope` are both RETIRED (route removed — `CONN-6`'s id is intentionally not reused). A connector is now unconditionally project-wide visible to every project member; the only gate on which agents may call it is the agent's own `connectors` grant (`[[agents]].connectors` in kortix.yaml, enforced by `iam/agent-scope.ts` — see `PROJ-agents` flows), not anything configured per-connector.

---

## 25. Parallel-authored domains (git/platform/iam/channels/queue/servers/audit/scim)

`GH-9` `GET /git/:project/info/refs` · `POST …/git-upload-pack` · `POST …/git-receive-pack` → smart-HTTP proxy, git token auth (not JWT); bad/no token → 401/502.
`GH-10` `GET /git/:project/info/refs` → user JWT is not a git token → 401/403; NONMEMBER → 401/403/404.
`GH-11` `GET /projects/:id/git/clone-credential` → runtime tokens only; ANON → 401, user JWT/account-PAT → 403.
`GH-12` `POST /projects/:id/git/collaborators` → missing username → 400; non-managed → 409; no install → 502.
`GH-13` `GET /projects/github/repositories` → PROJECT_CREATE; no App install → 409 install_url.
`GH-14` `POST /projects/create-repo` → PROJECT_CREATE; missing name → 400; no install → 409/503.
`GH-15` `POST /projects/link-repository` → PROJECT_CREATE; missing repo → 400; no install → 400/409/502; bad token → 400.
`PLT-3` `GET /platform/sandbox/version` · `…/latest` · `…/all` · `…/changelog` → 200 (public).
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
`CHN-13` `POST /projects/:id/channels/email/connect` → manage; requires project experimental `agentmail_email`; optional `connector_slug` scopes the inbox to one Email connector profile; optional existing `inbox_id` + `email` attaches an already-created AgentMail inbox; disabled → 403, invalid AgentMail key → 502 or no configured key → 503; non-member 403/404.
`CHN-14` `GET /projects/:id/channels/email/installation` → read → 200 null/summary for default or requested `connector_slug`; non-member 403/404.
`CHN-15` `DELETE /projects/:id/channels/email/installation` → manage → 200 for default or requested `connector_slug`; non-member 403/404.
`CHN-16` `POST /webhooks/email/agentmail` → public; accepts AgentMail's unwrapped message payload shape; unsigned local/unconfigured may 200, configured bad sig → 401, production without signing → 503.
`CHN-17` `GET /projects/:id/channels/email/mode` → read → 200 mode with enabled flag; non-member 403/404.
`CHN-18` `GET /projects/:id/channels/bindings` → read → 200 `{projectDefaultAgent,bindings[]}`; non-member 403/404; ANON 401.
`CHN-19` `PATCH /projects/:id/channels/bindings/:bindingId` → `project.connector.write`; unknown bindingId → 404; empty body → 400; non-member 403/404; ANON 401.
`Q-5` `GET /queue/sessions/:sid` (unknown) → 200 empty; ANON → 401.
`Q-6` enqueue → move-up/down + DELETE /messages/:mid → DELETE /sessions/:sid → 200.
`SRV-2` `POST /servers` 201 · `GET/PUT/DELETE /servers/:id` CRUD → read-after-delete 404.
`SRV-3` `POST /servers` missing fields → 400 · managed id → 400 · unknown id → 404.
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
`PROJ-9` `POST /projects/:id/manifest/validate {raw,format?}` → 200 {valid,issues}; missing raw → 400. `raw` is parsed as TOML or YAML — the format is derived from the project's configured `manifestPath` first, falls back to an explicit `format:"toml"|"yaml"` in the body, and defaults to `toml` for back-compat. A `kortix.yaml`-configured project's `raw` YAML validates correctly instead of silently mis-parsing as TOML.
`PROJ-10` `POST /projects/:id/cli-token` → 201 project PAT; `GET` → 200; `DELETE /:tokenId` → 200; unknown → 404.
`PROJ-11` `PATCH /projects/:id/onboarding {completed}` → 200; NONMEMBER → 403/404.
`PROJ-12` `GET /projects/:id/version-diff?from&into` → 200; missing → 400; same ref → is_same_ref.
`PROJ-13` `POST /projects/:id/oauth/:provider/start|poll` + `GET|DELETE /projects/:id/oauth[/:provider]` → poll-based device flow saving CODEX_AUTH_JSON; start unknown provider/invalid sharing → 400, poll missing flow_id → 400, poll bogus → expired, list → 200, delete unknown → 404, NONMEMBER → 404, ANON → 401.
`PROJ-14` `GET /projects/legacy-migration/eligibility` → 200; `status?sandbox_id` missing → 400; unknown → 404; ANON → 401.
`PROJ-15` `POST /projects/legacy-migration/start {sandbox_id}` → missing → 400; unknown → 404; non-justavps → 400.
`PROJ-16` `POST /projects/:id/turn-question {session_id,questions[]}` → missing → 400.
`PROJ-17` `POST /projects/:id/turn-stream {session_id,text}` → missing → 400; `kind:end|turn_end` needs only `session_id` (`status: idle|error`) → 200 `ok:false` when no live stream.
`PROJ-18` Project cap by plan: a FREE account may own exactly 1 project — `POST /projects/provision` for the 2nd → 403 `{code:project_limit_reached,limit}` (checked before any repo is provisioned); paid/team plans get `MAX_PROJECTS_PER_ACCOUNT`. Requires `freestyle`+`stripe` (billing enforced).
`PROJ-19` Full v2 agent-config editor (agent-first spec §2.2): `GET /projects/:id/agents/:agentName/config` (`read`) → 200 `{agent,schema_version,editable,default_agent,block}` — `editable:false` + `block:null` for a v1/empty manifest (the UI's degrade signal), the agent's full `AgentBlockV2` for a declared v2 agent; `PUT /projects/:id/agents/:agentName/config {…AgentBlockV2}` (`manage`, gated `project.customize.write`) validates the block through the manifest-schema validator (bad permission tree/enum/ungrantable `kortix_cli` → 400 `invalid_config`) then writes it into the `agents:` map in `kortix.yaml`; a v1 project is refused with a 400 upgrade pointer (v2-only); malformed body → 400 `invalid_body`; caller with no project grant → 404.
`MKTP-1` `GET /marketplace/items {query?,type?}` → auth → 200 `{items:[{id,registry,name,type,title,description,categories,capabilities,dependencies,fileCount,managedBy?,updatePolicy?}]}` (catalog includes the minimal Kortix runtime skills, optional General Knowledge Worker skills such as `pdf`, and curated bundles; the default starter does not ship the GKW pack; `?query=`/`?type=` filter).
`MKTP-2` `GET /marketplace/items/:id` → auth → 200 item detail (`files`, `readme`, `capabilities`, managed metadata when applicable); unknown id → 404.
`MKTP-3` `POST /projects/:projectId/marketplace/install {id}` → `write` → 201 `{commit_sha,branch,file_count,installed[],capabilities}` (resolves the catalog item + transitive bundle deps, commits its files + `registry-lock.json` to the default branch). Missing/unknown id → 400; missing project / `NONMEMBER` → 404/403. Legacy alias: `/registry/install`.
`MKTP-4` `GET /projects/:projectId/marketplace` → `read` → 200 `{installed:[{name,type,source,installed_at,file_count}]}` (from `registry-lock.json`; migrates legacy `skills-lock.json`); missing project → 404. Legacy alias: `/registry`.
`MKTP-5` `DELETE /projects/:projectId/marketplace/:name` → `write` → 200 `{ok,removed,commit_sha,branch,file_count}` (removes the item's files + lock entry in one commit to the default branch); item not installed → 404; missing project / `NONMEMBER` → 404/403. Legacy alias: `/registry/:name`.
`APP-2` `POST /projects/:id/apps` · `PATCH/DELETE /:slug` → gate off → 404; bad body → 400; dup → 409; unknown → 404.
`APP-3` `POST /:slug/deploy|stop` · `GET /:slug/logs` → unknown/no-deploy → 404.
`APP-4` `PATCH /projects/:id/apps-config {enabled}` → 200; non-bool → 400 (not behind apps gate; legacy alias for the `apps` experimental feature).
`EXP-1` `PATCH /projects/:id/experimental {feature,enabled}` → 200 with `experimental`/`experimental_features` in body; unknown feature → 400; non-bool enabled → 400; `enabled:null` clears the override → 200.
`SNAP-3` `POST /projects/:id/snapshots/fix-with-agent` → no failed build → 409; else 201.
`SBX-3` `GET /projects/:id/sandboxes` · `/sandbox-health` · `/sandbox-templates` → 200.
`SBX-4` `POST /sandbox-templates` → 201; bad → 400; reserved/dup → 409; `PATCH/DELETE/build /:templateId`; unknown → 404.
`PACC-5` `POST /projects/:id/access/invite` → 201 pending; `GET/POST resend/DELETE pending-invites[/:id]` → manage; missing email → 400; unknown → 404.
`PACC-6` `GET/POST /projects/:id/group-grants` · `PATCH/DELETE /:groupId` → manage; POST/PATCH accepts optional nullable `default_base_ref` for that group's human-launched session default; missing group_id → 400; unknown → 404.
`BILL-10` per-seat: `POST /billing/sync-seat-quantity` · `claim-per-seat` → no-op/skipped on non-legacy.
`AUTH-1` `POST /v1/auth/logout` → OWNER 200/204; ANON 200/401.
`BILL-11` `GET /billing/checkout-session/:sessionId` · `POST /billing/confirm-checkout-session` → unknown/missing → 4xx.
`BILL-3b` `POST /billing/create-checkout-session` · `create-per-seat-checkout` · `create-portal-session` → Stripe URL or 400/500.
`BILL-4b` `POST /billing/cancel-subscription` · `sync-seat-quantity` → NONMEMBER → 403.
`DEL-2b` `/billing/account/*` deletion mirror — request → cancel lifecycle.
`SESS-11` session sub-routes (commit-push/ensure-opencode/restart/wake) → unknown/non-uuid session → 4xx (happy paths need a funded session, run on dev-api).
`SEC-5` `PUT/DELETE /projects/:id/secrets/:name/personal` → per-user secret override set/clear.
`CONN-10` `POST /executor/projects/:id/connectors/:slug/connect[/finalize]` → pipedream; unknown connector → 404/501.
`CONN-11` `POST /executor/webhook/pipedream` → public; bad/unsigned payload → rejected.
`CONN-12` `GET /executor/projects/:id/connectors/:slug/config` → admin reads a connector's connection def for editing; unknown connector → 404/501; NONMEMBER → 403.
`DEL-3` `DELETE /v1/account/delete-immediately` (+ /billing mirror) → ANON → 401 (auth boundary; destructive happy path not run).

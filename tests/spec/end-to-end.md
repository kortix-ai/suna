# Kortix End-to-End Flows

Single source of truth for the e2e suite. Every flow the platform supports, start→finish, enumerated. Each step is `METHOD /path → expected`. CLI steps are `kortix …`. Negatives (`→ 4xx`) are part of the flow, not optional. Each flow has a stable ID (`PROJ-3`, `IAM-7`) so a test maps 1:1 to a line here.

Stack: TypeScript/Hono on Bun (`apps/api`), Drizzle→Postgres (`kortix` schema), Next.js (`apps/web`), `kortix` CLI (`apps/cli`). **No RLS** — all authz is app-layer via the IAM engine, so every assertion must go through the HTTP API. Sessions use OpenCode REST inside an ephemeral per-session sandbox.

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
- Auth middlewares: `supabaseAuth` (JWT or PAT) on `/v1/accounts/*`, `/v1/projects/*`, `/v1/platform/api-keys`. `combinedAuth` (JWT|token|PAT|cookie|`X-Kortix-Token`|`?token=`) on `/v1/p/*`, `/v1/servers/*`, `/v1/tunnel/*`. `apiKeyAuth` (kortix_ only) on `/v1/router/*`. `requireAdmin` (platform role) on `/v1/ops/*`. Webhooks = HMAC, no auth middleware.
- Project authz gate `loadProjectForUser(c, id, level)`: `read`→`PROJECT_READ` (any project role), `write`→`PROJECT_WRITE` (manager), `manage`→`PROJECT_DELETE` (manager only). Account owner/admin get implicit `manager` on every project.

### Principals (fixtures every run must provision)

| Key                               | What                                                 | Used to assert                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OWNER`                           | account owner (super-admin, bypasses policy)         | full access                                                                                                                                                                                                                                                                                    |
| `ADMIN`                           | account `admin` (Administrator policy)               | all but account.delete / billing.write / owner-grant                                                                                                                                                                                                                                           |
| `MEMBER`                          | account `member`, **no** project grant               | account-reads only; cannot see projects                                                                                                                                                                                                                                                        |
| `M_VIEWER` `M_MANAGER` | member + a project-scope role assignment (member/manager) | per-project (read + run-sessions) / +customize (write) +manage. `member` is the base _usable_ role: it can read AND start/run/stop sessions (use the agent chat) — it just can't customize the project. So POST `/projects/:id/sessions` is allowed for M_VIEWER; PATCH `/projects/:id` is not. The `editor` role was REMOVED 2026-08-18: it folds to `manager` on read and 400s on write |
| `BILLING`                         | `billing_manager` policy                             | billing read+write only                                                                                                                                                                                                                                                                        |
| `AUDITOR`                         | `auditor` policy                                     | reads + audit only                                                                                                                                                                                                                                                                             |
| `RO_ADMIN`                        | `administrator_read_only`                            | read-only everywhere                                                                                                                                                                                                                                                                           |
| `DENY_USER`                       | member with explicit `deny` policy on a project      | deny-wins over any allow                                                                                                                                                                                                                                                                       |
| `NONMEMBER`                       | user in a different account                          | 403 `not_a_member` / 404                                                                                                                                                                                                                                                                       |
| `PAT_ACCT`                        | account-scoped PAT minted by OWNER                   | inherits minter unless narrowed                                                                                                                                                                                                                                                                |
| `PAT_PROJ`                        | project-scoped PAT (minted per session)              | hard-fenced to one project                                                                                                                                                                                                                                                                     |
| `APIKEY`                          | `kortix_` api key                                    | router/proxy + sandbox identity                                                                                                                                                                                                                                                                |
| `ANON`                            | no Authorization header                              | 401 on protected routes                                                                                                                                                                                                                                                                        |

### System / health (public unless noted)

`SYS-1` `GET /health` · `GET /v1/health` → 200 `{status:"ok",service:"kortix-api"}`.
`SYS-2` `GET /v1/system/status` → maintenance/banner stub. `POST /v1/prewarm` → `{success:true}`.
`SYS-3` `GET /v1/user-roles` (`supabaseAuth`) → `{isAdmin, role}` (platform role).
`SYS-4` `GET /v1/router/health` → router health (no auth).
`SYS-5` 404 shape — `GET /v1/nonexistent` → `{error:true,message:"Not found",status:404}`. Every state-changing `/v1/*` passes `auditStateChangingRequest`.
`SYS-6` `GET /v1/system/maintenance` → public read of the maintenance config (banner + maintenance page); default `{level:"none",…}`. Write is admin-only (`ADM-6`).
`SYS-7` `POST /v1/system/demo-request` → public lead capture for the marketing "book a demo" and careers forms; invalid email → 400; valid → 200 `{ok:true, emailed, persisted}`. Owns both side effects of a lead, each best-effort and independent: it emails `DEMO_LEAD_NOTIFY_EMAIL` via the transactional-email provider chain (SES → Resend → Mailtrap) — `emailed:false` when no provider is configured — and stores the submission verbatim (unknown keys included) as one jsonb blob in `public.contact_forms` — `persisted:false` when the deployment has no database or no such table. Neither failure fails the lead. IP rate-limited (`KORTIX_DEMO_REQUEST_REQS_PER_MIN`, 429 on flood).
`DOCS-1` `GET /v1/openapi.json` → public OpenAPI 3.1 spec (typed via `@hono/zod-openapi`). `GET /v1/docs` → public Scalar API reference (HTML).

### Kortix system skills (`/v1/skills`, `combinedAuth`)

The kortix-managed `kortix-*` skills — the markdown that tells an agent how Kortix itself works — served straight out of `@kortix/starter`, so the text always matches the running deploy. This is what lets an agent in any harness drive Kortix with nothing but the `kortix` binary and a token. Authed (any Kortix token or Supabase JWT), never anonymous; content is identical for every caller (no account scoping).

`SKILL-1` `GET /v1/skills` → auth → 200 `{skills:[{name,description,referenceCount,bytes}],count}`. Bodies are NOT included — the frontmatter `description` is parsed server-side so an agent can choose without downloading ~330 KB of markdown. `ANON` → 401.
`SKILL-2` `GET /v1/skills/:name [?full=1]` → auth → 200 `{name,description,body,references:[{path,bytes,content?}]}`; `body` is the complete SKILL.md. `?full=1` inlines every reference file. Unknown/non-managed name → 404. `ANON` → 401.
`SKILL-3` `GET /v1/skills/:name/file?path=` → auth → 200 `{name,path,content}` for one reference file. Missing `path` → 400; unknown path or traversal attempt → 404 (lookup is exact-match against the in-memory index, not a filesystem read). `ANON` → 401.

### Sandbox runtime assets (`/v1/runtime-assets`, `combinedAuth`)

The `kortix` CLI binary and the managed-skill overlay THIS deploy was built with. A sandbox bakes both at image-build time and then never re-runs that build — restart and resume wake the same VM, and a warm fork adopts a captured disk — so without these routes a box provisioned months ago keeps a months-old CLI forever and 404s the moment a route is renamed. The daemon reconciles against them at every session start, restart, resume, and `POST /kortix/refresh`. Same auth as `/v1/skills`, and for the same reason: the caller is the in-sandbox `KORTIX_CLI_TOKEN`.

`RTA-1` `GET /v1/runtime-assets/manifest` → auth → 200 `{cli_version,cli_sha256,cli_size,managed_skills_hash,managed_skills_count}`. Digests only — a sandbox decides from this alone whether to download anything. The CLI fields are all-null together when the image carries no binary (a checkout that never built `apps/cli/dist/kortix`); the manifest must still serve the skill half. Stable within a deploy. `ANON` → 401.
`RTA-2` `GET /v1/runtime-assets/managed-skills` → auth → 200 `{hash,files:[{path,content}]}`, `ETag` = the manifest's `managed_skills_hash`, every path inside the `kortix-*` family. `If-None-Match` with the current hash → 304 with no body; a stale hash → 200. `ANON` → 401.
`RTA-3` `GET|HEAD /v1/runtime-assets/cli` → auth → 200 the Linux binary, `ETag` = the manifest's `cli_sha256`, `Content-Length` = `cli_size`, `X-Kortix-Cli-Sha256` naming the digest the caller must verify. `If-None-Match` with the current digest → 304 with no body — a converged sandbox transfers nothing. No binary in the image → 404. `ANON` → 401.

---

## 1. GOLDEN PATH (master flow — init → ship → run → merge)

The single flow that, if green, proves the platform end-to-end. Each substep links to a section.

`GOLD-1`

1. `kortix init <name> -y` → creates a fresh standalone `<name>/` directory, writes `kortix.yaml` + `.kortix/`, wires agent skill, and runs `git init -b main`. No API call. (§2)
2. `kortix login --token $PAT` → `GET /accounts/me` → 200, host saved active. (§2)
3. `kortix ship -y` (no `origin` present) → managed path: `POST /projects/provision` → 201 `{push_token, repo_id, repo_url}`; `git remote add origin <managed GitHub URL>`; commit; token-header push; writes `.kortix/link.json`. (§14)
4. Poll `GET /projects/:id/snapshots` → wait for a `ready` snapshot. (§4)
5. `kortix secrets set STRIPE_API_KEY=sk_live_…` → `POST /projects/:id/secrets` → 200. (§6)
6. `kortix sessions new -p "add a README"` → `POST /projects/:id/sessions` → 201 status `provisioning`; branch `<sessionId>` created. (§7)
7. Poll `GET /projects/:id/sessions/:sid/sandbox` → status `provisioning`→`active`. (§8)
8. `POST /p/<sandboxId>/8000/session` then `POST /p/<sandboxId>/8000/session/<ocId>/prompt_async` → 204; subscribe `GET /p/<sandboxId>/8000/event` (SSE) → see message deltas; agent commits to branch. (§9)
9. `POST /projects/:id/change-requests {head_ref:<sessionId>, title}` → 201; `GET …/:crId/merge-preview` → mergeable; `POST …/:crId/merge` → 200 status `merged`. (§11)
10. `DELETE /projects/:id/sessions/:sid` → 200 status `stopped` (branch preserved). (§7)

---

## 2. CLI — local + auth (no/low API)

`INIT-1` `kortix init <name> -y` → fresh standalone `<name>/` with `kortix.yaml` + `.kortix/` (Dockerfile, `.kortix/opencode/…`, canonical skill), agent wiring, and `git init -b main`. **Zero API calls.** Exit 0.
`INIT-2` `kortix init <name>` when `<name>/` already exists and is non-empty → exit 1 (refuses).
`INIT-3` `kortix init <name> --primary opencode --agents claude,cursor -y` → chosen agents wired via symlinks (native dir → OpenCode config) + `AGENTS.md` for Codex/Cursor; no `.cursor` rule file; unselected agents skipped.
`INIT-4` `kortix init <name> --no-git` → scaffold created with no repository.
`CREATE-1` bare `kortix <name>` is an unknown command → exit 2, explains `kortix init <name>`, and never creates a directory. Scaffolding is explicit-only so mistyped commands cannot mutate the filesystem.
`LOGIN-1` `kortix login --token kortix_pat_…` → validate `kortix_pat_` prefix → `GET /accounts/me` → 200 → host saved + active in `~/.config/kortix/config.json` (mode 0600).
`LOGIN-2` `kortix login` (browser) → spins one-shot `127.0.0.1:<port>` callback with 32-byte `state`, opens `$WEB/cli/authorize?callback=…&state=…`; dashboard POSTs `{state,token}`; state-mismatch or non-`kortix_pat_` → rejected; valid → `GET /accounts/me` → saved.
`LOGIN-3` `kortix login --token <bad>` → `GET /accounts/me` 401 → "token rejected", exit 1.
`LOGIN-4` already-logged-in host, no flags → no-op.
`WHOAMI-1` `kortix whoami` → `GET /accounts/me` → prints email/user_id/active account/role. 401 → re-login prompt.
`LOGOUT-1` `kortix logout` → removes host creds; if active, switches to next host or deletes config. No API.
`HOSTS-1` `kortix hosts ls` → list the built-in and configured hosts without an API request.
`HOSTS-2` `kortix hosts use <name>` → switch the active host; an unknown host exits 1.
`HOSTS-3` `kortix hosts add <name> --url <url>` → add one custom host; a duplicate name exits 1.
`HOSTS-4` `kortix hosts rm <name>` → remove one custom host; an unknown host exits 1.
`HOSTS-5` `kortix hosts info [name]` → show the selected or active host.
`HOSTS-6` `kortix hosts current` → print the active host name.

---

## 3. Access gating / signup (public)

`ACC-1` `GET /access/signup-status` → 200 `{open|waitlist}`.
`ACC-2` `POST /access/check-email {email}` → 200 `{allowed, mode: signin|signup|closed|sso}` (`signin` = account exists, `signup` = may register, `closed` = signups off + not allowlisted, `sso` = domain's org enforces SSO-only sign-in; per-IP rate-limited → 429).
`ACC-3` `POST /access/request-access {email,…}` → 200 waitlisted.
`ACC-4` (self-hosted only, `isLocal()`) `GET /setup/install-status` + `GET /setup/sandbox-providers` → public; `POST /setup/bootstrap-owner` → first owner; `GET /setup/status|health|setup-status`; `GET/POST /setup/setup-wizard-step`, `POST /setup/setup-complete`. Cloud → routes 404.

---

## 4. Accounts & identity

`ME-1` `GET /accounts/me` → 200 user + memberships. `ANON` → 401.
`ACCT-1` `GET /accounts` → list memberships (auto-claims pending invites by email).
`ACCT-2` `POST /accounts {name}` → 201 team account, caller = `owner` (an `account_memberships` identity row plus an account-scope `owner` assignment).
`ACCT-3` `GET /accounts/:id` → member → 200; `NONMEMBER` → 403.
`ACCT-4` `PATCH /accounts/:id {name}` → `ACCOUNT_WRITE` (OWNER/ADMIN) → 200; `MEMBER` → 403.

### Members

`MEM-1` `GET /accounts/:id/members` → every account member sees the teammate directory; PAT counts, MFA, groups, and project-grant counts are visible only on self unless the caller can manage members.
`MEM-2` `POST /accounts/:id/members {email,role}` → `MEMBER_INVITE` (OWNER/ADMIN) → **201** (`status:added` existing user / `status:pending` new); already a member → 409; `MEMBER` → 403.
`MEM-3` `PATCH /accounts/:id/members/:userId {role}` → `MEMBER_UPDATE` → 200; same role → 200 `{unchanged:true}` (no-op); **promoting/demoting `owner` additionally requires `MEMBER_SUPER_ADMIN_GRANT`** (owner only) → ADMIN owner-grant → 403; **promotion to owner/admin deletes the member's project-scope assignments** (owner/admin hold implicit Manager on every project, so a direct grant would shadow nothing).
`MEM-4` `DELETE /accounts/:id/members/:userId` → `MEMBER_REMOVE`; ADMIN removing an OWNER → 403; removing the **last owner** → 409; also cascades every assignment the member held — project-scope, account-scope and custom-role alike — and then their `account_memberships` identity row.
`MEM-5` `POST /accounts/:id/leave` → 200; **last owner** → 409; **personal account** → 409; **non-member → 404**.

**Trial seat gate (`SEATS`).** While an admin-issued trial is active (`ADM-14`) on a **non-`per_seat`** account, admitting a member beyond the trial's `seats` → **403 `{code:"trial_seat_limit_reached", limit, members}`**. The gate fires on all three admission paths: `MEM-2` direct add (`POST /accounts/:id/members`), invite creation, and `INV-4` invite accept — the accept-side check is the authoritative one (it runs at the moment the membership row is written) and it never blocks an EXISTING member re-entering, so grant-healing still works. A `per_seat` account is exempt: Stripe seat quantity governs it, not the trial.

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

Group/role/policy-writing and SSO/SCIM-writing routes are ALSO gated behind `requireEntitlement` (`rbac`/`sso`/`scim` — see `IAM-32/33`): a fresh account with no billing row resolves to tier `none` (`NO_ENTERPRISE`), so `IAM-1/2/3/14/21/23/24/25/26` first `PUT …/iam/enterprise-demo {enabled:true}` on their `team()` fixture account to unlock the surface before exercising it — a real Enterprise tier would work identically, the demo flag is just the operator-issued stand-in used in-suite. That PUT is **platform-admin-only** (`IAM-32`), so the unlock runs as the **run-scoped platform admin** the run provisions (`env.adminToken`, `fixtures/world.ts` + `fixtures/enterprise-demo.ts`), never as the fixture account's OWNER. A target with no platform admin cannot unlock the surface at all; those flows fail fast with that reason instead of asserting against a locked account.

`IAM-1` `GET …/iam/groups` (`GROUP_READ`) · `POST` (`GROUP_CREATE`, `rbac`-gated) → 201.
`IAM-2` `GET/PATCH/DELETE …/iam/groups/:gid` (`GROUP_READ`/`UPDATE`/`DELETE`).
`IAM-3` `GET …/iam/groups/:gid/members` (`GROUP_READ`); `POST`/`DELETE …/members/:userId` (`GROUP_MEMBERS_MANAGE`).
`IAM-4` Effective probe: `GET …/iam/members/:userId/effective?action=…[&resourceType=&resourceId=]` (`MEMBER_READ`; self-probe always allowed) → `{allowed, reason, action, resource_type}`. Built-in account/project membership remains the default decision source; custom policies are additive and covered in `IAM-25/26`.
`IAM-5` Built-in role behavior is observable via the effective probe (`account.write` allowed for admin/owner, denied for member); the explicit action/role catalog read surface is covered in `IAM-25`.
`IAM-6` Built-in roles are immutable code-defined presets; custom role CRUD/permissions are covered in `IAM-25`.
`IAM-7` `PATCH …/iam/members/:userId/super-admin {isSuperAdmin:bool}` (`MEMBER_SUPER_ADMIN_GRANT`, OWNER only) → grant/revoke super-admin; ADMIN → 403.
`IAM-8` `GET …/iam/members/:userId/groups` · `…/effective` (`MEMBER_READ`) → effective permission set.

### Engine semantics (assert via behavior, not endpoints)

`IAM-9` **super-admin bypass** — the account creator is super-admin; their effective probe (`…/members/:userId/effective`) is `allowed:true reason:super_admin` for every action (account-write, project.create, and any project action on any/unknown project) regardless of policies or project membership. A revoked-super-admin owner still passes via `role`, never `super_admin`. Asserted via the effective endpoint.

> **Allow-reason contract (canonical RBAC).** Every ALLOW that comes from a role the principal holds reports `reason:"role"`. The pre-canonical engine reported `account_role`, `project_role` or `custom_policy` depending on which of the five grant stores the row lived in; `role_assignments` is now the only store, so the distinction has no referent. DENIAL reasons are unchanged (`account_role_insufficient`, `project_role_insufficient`, `no_project_membership`, `resource_scope_insufficient`, `agent_scope_insufficient`, `service_account_scope_insufficient`, `token_out_of_scope`, `account_mfa_required`, `not_a_member`), because each names a constraint the caller can act on and `denial-message.ts` is keyed on them.
`IAM-10` **no deny precedence** — V2 has NO deny rules (engine: "No deny precedence"; access is allow-by-role only, max-role-wins across direct+group sources). There is no constructible allow+deny conflict via real routes. Closest assertion: stack a low (viewer) direct role and a high (manager) group grant on the same project — effective `project.delete` is `allowed:true` (max wins, never denied by the lower grant). NOTE: classic deny-wins is unverifiable black-box because the feature does not exist.
`IAM-11` **PATs inherit the minter (no token-only policy eval)** — V2 has no per-token policies; a PAT carries no narrowing policy set, it only optionally binds to one project (`account_tokens.project_id`). An unscoped account PAT's effective access equals its minter's (owner → super-admin set). Asserted by exercising the same `…/effective` reads as the JWT owner. NOTE: per-token policy evaluation is unverifiable black-box because the feature does not exist; project-bound-PAT scope narrowing is covered indirectly by the token/scope flows, not here.
`IAM-12` **account role → action set** — the account-scope role assignment maps to the action set: a plain `member` gets account-reads only — `account.read` allowed but `account.write`/`project.create` denied (`reason:account_role_insufficient`), and a project action on a project they're not on is denied (`reason:no_project_membership`), so they cannot reach all projects. owner/admin → Administrator-level set (`account.write` allowed; implicit Manager on every project). Asserted via the effective endpoint.
`IAM-13` **scope match** — a project group-grant matches only its own project. Grant a group Manager on project A; a member of that group probed with `resourceType=project&resourceId=A` → `project.delete` allowed (`reason:role`); the same probe against project B (no grant) → denied (`reason:no_project_membership`). Asserted via the effective endpoint with/without the matching `resourceId`.
`IAM-25` Custom roles/action catalog: `GET …/iam/actions`, `GET/POST/PATCH/DELETE …/iam/roles`, `GET/PUT …/iam/roles/:roleId/permissions`, `GET …/usage`. Invalid role key → 400; built-in role permission edit/delete → 400.
`IAM-26` Custom policies: `GET/POST/PATCH/DELETE …/iam/policies`, `POST …/iam/policies:bulk-delete`, `POST …/iam/policies:bulk-import`, plus `GET …/iam/agent-identities`. Built-in role policy → 400; non-member read → 403.

### Approval control-plane (project access-requests, approvals, agent/connector scoping)

The human-in-the-loop surface an agent's write/destructive tool calls gate on, plus its adjacent per-agent scoping and the Enterprise preview/import surfaces. `GET /projects/:id/approvals[/needs-input]` and `POST /projects/:id/approvals/:id` gate on plain IAM capability (`project.members.manage`/`project.read`), never a billing tier — see PR #4117 (a prior 402 regression on the per-session audit poll); these must never start 402ing.

`IAM-27` `POST /projects/:id/access-requests {message?}` (any signed-in caller; already-has-access short-circuits `{status:"already_has_access"}`) → 201 `{status:"created",request}`; re-request while pending → 200 `{status:"pending",request}`. `GET /projects/:id/access-requests` (`project.members.manage`) → 200 `{requests:[...]}` pending only; caller with no project grant → 403; unknown project → 404.
`IAM-28` `POST /projects/:id/access-requests/:rid/approve {role?}` / `.../reject` (`project.members.manage` — stricter than plain `manage`/`project.write`, so a project member without members-manage → 403) → 200 grants the project role (`ensureOrgMembership` + `grantProjectRole`) and marks the request `approved`/`rejected`; invalid `role` → 400; already-reviewed → 409; unknown request id → 404.
`IAM-29` `GET /projects/:id/approvals` (manager-only inbox of unresolved `pending_approval` connector actions) → 200 `{count,approvals}`; out-of-range `limit` → 400; non-manager with no grant → 403. `GET /projects/:id/approvals/needs-input` (`read` — any project member) → 200 `{total,sessions}`; a manager sees every session's pending count, a non-manager only their own launched sessions; non-member → 403.
`IAM-30` `POST /projects/:id/approvals/:executionId {decision:"approve"|"deny",scope?}` (manager OR the session launcher) → resolves a pending connector action atomically (TOCTOU-safe); malformed execution id → 400; invalid `decision` → 400 (validated before the row lookup); unknown execution id → 404; non-project-member → 403; already-resolved → 409 (happy-path resolve of a REAL pending row needs a live governed connector call from an agent session — not black-box reproducible here, same constraint as `SESS-11`).
`IAM-31` `PUT /projects/:id/agents/:agentName/scope {env?,connectors?}` (`manage`) — writes the `[[agents]].env`/`.connectors` allowlists into `kortix.yaml` (or legacy `kortix.toml`); empty body (`nothing_to_update`) → 400; malformed grant set → 400; unknown agent name → 404 (`agent_not_found`); caller with no project grant → 403.
`IAM-32` `GET/PUT /accounts/:id/iam/enterprise-demo {enabled}` — the Enterprise-preview flag, fail-closed/default-off and deliberately NOT behind `requireEntitlement`. **The two verbs have different auth.** `GET` stays `account.read`, so the account page can render the state: OWNER → 200 `{enabled}`, plain `MEMBER` → 200 `{enabled}`, `NONMEMBER` → 403. `PUT` is **platform-admin-only** (`isPlatformAdmin`, no account-membership check — an operator is normally not a member of the account they enable): the account **OWNER**, despite holding `account.write`, → **403 `{code:"admin_required"}`** and the flag is unchanged; a **platform admin** → 200 `{enabled}`; non-boolean `enabled` → 400 (validated after the admin check, so a non-admin still gets 403 for a bad body). Enabling the preview used to be self-serve, which made an Enterprise entitlement something any account member could grant themselves; it is an operator decision now, normally taken from the admin console (`ADM-17`), which writes the same `credit_accounts.demo_enterprise` column this GET reads.
`IAM-33` `POST /accounts/:id/iam/sso/provider/from-metadata {metadata_xml|metadata_url,name,primary_domain,domains?}` (`account.write` + `sso` entitlement) — self-serve SAML IdP registration via the Supabase auth admin API; non-Enterprise account → 402 `{code:"entitlement_required",entitlement:"sso"}` (the platform admin enabling `enterprise-demo` above unlocks it for the same account); missing name/invalid domain → 400; neither `metadata_xml` nor `metadata_url` → 400 (or 501 if the deployment has no `SUPABASE_SERVICE_ROLE_KEY`); existing provider → 409; NONMEMBER → 403.
`IAM-34` `GET /approval-links/:token` requires a signed-in user before resolving the token. ANON → 401. An authenticated caller with an invalid token → 404 without exposing project or execution data.

### Canonical assignments (the ONE grant store)

`IAM-35` `GET/POST/DELETE /accounts/:id/iam/assignments` — the single grant surface over `kortix.role_assignments`, which replaces `account_members.account_role`, `project_members`, `project_group_grants`, `iam_policies` and `iam_resource_grants`. The write routes assert nothing themselves: `assignRole` picks the required permission from WHAT is granted (`project.members.manage` for a project role or an object grant, `member.update` for an account role, `policy.create` for a custom role), so the ceiling cannot be side-stepped by choosing a different endpoint. `POST` is an UPSERT on `(principal, role, scope, object)` — re-granting returns the same `assignment_id`, never a duplicate. Malformed `principal_id`/`scope_id`/`role_id` → 400 naming the field (was a 500 from the `::uuid` cast). A principal that does not exist — a user with no auth row, a group or an active service account outside this account — → 404; the service-account case matters most because agent identities are auto-provisioned by NAME, so a grant planted against a guessed id would come alive the first time that agent launched. Assigning a custom role requires the `rbac` entitlement → 402 without it.

`IAM-36` `DELETE /accounts/:id/iam/assignments/:assignmentId` removes THE row. There is no second store to keep in step any more: `project_members`, `project_group_grants`, `iam_policies` and `iam_resource_grants` are VIEWS over `kortix.role_assignments`, and `account_members.account_role` is a derived view column, so the one delete is visible under every legacy name at once. Revoking the account's last `owner` → 409. Revoking a principal's ONLY account-scope role → 409 pointing at `DELETE /accounts/:id/members/:userId`, which is the path that also revokes their tokens and releases the seat; a DEMOTION is a grant of the lower role followed by this revoke, or one `POST` with the replacement role (an account-role grant is exclusive and retracts the role it replaces). Unknown or malformed id → 404.

`IAM-37` `GET /accounts/:id/iam/permissions` (`role.read`) — the action catalog as DATA: `scope_type` (the ONE classifier), `delegable` (the escalation ceiling, formerly the hardcoded `NON_DELEGABLE_ACTIONS` Set), `area`, `level`, `implies[]`, and a non-empty one-sentence `description` for every row. `project.cr.open`/`project.cr.merge` and the `trigger.*` family are absent (collapsed and deleted). `scope_type=account|project` narrows it. A plain member → 403.

`IAM-38` `GET /accounts/:id/iam/roles` lists SYSTEM roles from the seeded `iam_roles` rows (`account_id IS NULL`), not from a code constant: all six, `agent-user` included, each with `is_system:true`, its seeded `name`/`description`, and the `key` the store uses — so the key a client reads back is the key `POST /iam/assignments {role_key}` accepts. Ids stay `builtin:<key>`, with the ONE alias `builtin:user` for the project floor role (whose store key is `member`, and `builtin:member` is the ACCOUNT floor role). `GET …/iam/roles/:roleId/permissions` serves a system role's actions from `role_permissions`. Editing, deleting or binding any system role → 400. The historical project-role names (`user`, `viewer` → `member`; `editor` → `manager`) still resolve on write.

### Read models over the canonical store

`IAM-39` Every access screen reads `role_assignments`, so it can no longer disagree with the gate that runs a moment later: `GET /projects/:id/access` (members, `group_access`, `custom_role_policies`, `resource_grants`, `effective_project_role`/`effective_source`), `GET /accounts/:id/members` (`account_role`, `explicit_project_count`, `projects[]`), `GET …/iam/members/:userId/project-access`, `GET …/iam/policies`, `GET …/iam/resource-grants`, `GET /projects` (`effective_role`), `GET …/iam/groups/:gid/project-grants`, `GET /projects/:id/group-grants`, `GET /projects/:id/resource-grants`. Response shapes are unchanged. TWO changes are deliberate and observable: (a) an EXPIRED grant is no longer listed — the legacy queries filtered nothing, so a lapsed grant kept rendering as live access and kept counting towards the effective role, while the engine had already stopped honouring it; (b) `policy_id` and `grant_id` ARE the assignment id — one id space, because `iam_policies` and `iam_resource_grants` are views whose primary key is `role_assignments.assignment_id`. A genuinely pre-cutover id (held by a page rendered before the migration ran) no longer resolves and gets a 404; reloading the page yields the current id.

---

## 6. Projects — CRUD + access

DB `projects` (`status active|archived`, unique `(account_id, repo_url)`). Soft delete → `archived`.

`PROJ-1` `GET /projects` → OWNER/ADMIN: all account projects; `MEMBER`: only the projects they hold an assignment on; `NONMEMBER`: empty/own only.
`PROJ-2` `POST /projects {repo_url,name}` (BYO) → `PROJECT_CREATE` (OWNER/ADMIN) → 201, creator granted `manager`, snapshot build kicked. `MEMBER` → 403. Non-GitHub `repo_url` → 400.
`PROJ-3` `POST /projects/provision {name,provider?:github}` (managed) → `PROJECT_CREATE` → 201 `{push_token,repo_id,repo_url}`. Unconfigured managed GitHub backend → 503.
`PROJ-4` `POST /projects/create-repo {name,private?}` (new GitHub repo) → `PROJECT_CREATE` → 201; no account GitHub App install → 409 + `install_url`; auto-dedupes name collision.
`PROJ-14` `POST /projects/provision-stream {name,provider?:github}` uses the same provision core as `PROJ-3`. An authorized request returns `200 text/event-stream` with data-only JSON frames. It emits ordered `phase` frames and exactly one terminal `done` or `error` frame. An unsupported provider emits `phase:validating`, then `error` with `status:400`, before any external call. ANON → 401 before the stream opens.
`PROJ-5` `GET /projects/:id` → `read` → 200 (bumps `last_opened_at`); archived → 404; `NONMEMBER` → 403.
`PROJ-6` `GET /projects/:id/detail` → `read` → 200 project + parsed `kortix.yaml` (agents/skills/env) + file list.
`PROJ-7` `PATCH /projects/:id {name,default_branch,manifest_path}` → `manage` (M_MANAGER/OWNER/ADMIN) → 200; M_EDITOR/M_VIEWER → 403.
`PROJ-8` `DELETE /projects/:id` → `manage` → 200 status `archived`; M_EDITOR → 403.

### Project access (membership)

`PACC-1` `GET /projects/:id/access` → `read` → members + effective project roles.
`PACC-2` `POST /projects/:id/access/invite {email,role}` → `manage`. **Existing Kortix user → 200** — `ensureOrgMembership` auto-adds them to the org as `member` then grants the project role (account-manager target → implicit access, `project_role:null`). **Email with no Kortix account yet → 201 `{status:"invited", invite_id, invite_url, project_role}`** — an account invitation with a `bootstrap_grant` is created/merged idempotently so they land on the project at signup. Missing email / bad role → 400; non-account-member caller → 403 (`loadProjectForUser` — 404 only when the project row is missing/archived).
`PACC-3` `PUT /projects/:id/access/:userId {role}` → `manage`.
`PACC-4` `DELETE /projects/:id/access/:userId` → `manage`.
`PACC-7` `GET/POST/DELETE /projects/:id/resource-grants[/:grantId]` → manager-only per-resource scoping. **AGENT-ONLY (resource-model simplification): `agent` is the only member/department-scopable resource** — assigning an agent lets the assignee USE it and inherit its declared skills/connectors/secrets (to USE, not edit; editing needs the manager role). A POST with `resource_type=skill` or `secret` → **400** (agent-only; the guard runs before any config/DB load, so no existing resource is needed). Reading/listing/revoking pre-existing skill/secret grant rows still works (back-compat), but none can be CREATED. GET lists grantable resources (`$.resources.agents`) + existing grants. POST `resource_type=agent` with a real agent id + member/group principal → 201; unknown/invalid `resource_type` (e.g. `database`) → 400; invalid/foreign principal → 400/404; deleting unknown grant → 404.

---

## 7. Sessions (ephemeral branch + sandbox)

DB `project_sessions` (`status queued|branching|provisioning|running|stopped|failed|completed`, unique `(project_id, branch_name)`). Branch name = `session_id`.

`SESS-1` `POST /projects/:id/sessions {agent_name?,initial_prompt?,base_ref?,provider?,name?,session_id?,branch_already_created?,runtime_context?}` → `session` (any project member, **M_VIEWER included** — viewer is the base usable role) → 201 status `provisioning` (fire-and-forget sandbox). `runtime_context` is an optional non-secret scalar map (max 64 entries / 16 KiB UTF-8 JSON; lower-case semantic keys only; no credential-like keys); it is stored outside user-editable session metadata and restored into every replacement runtime as the single server-owned `KORTIX_SESSION_CONTEXT` JSON variable. Nested/oversize/reserved/credential-shaped input → 400 before session persistence or provisioning; raw env/MCP fields are unknown and rejected. MEMBER with no project grant / NONMEMBER → 403. (An invalid `provider` for an allowed caller → 400, proving the role gate passed before provider validation.)
`SESS-2` concurrency cap — Nth session over tier cap → **429** + `X-RateLimit-Limit/-Remaining` headers.
`SESS-3` CLI client-branch optimization — `kortix sessions new`: if server can't self-create a branch through its configured Git credentials AND local `origin` == `project.repo_url`, CLI mints uuid, `git push origin HEAD:refs/heads/<uuid>`, then posts `session_id`+`branch_already_created:true`+`base_ref`.
`SESS-4` `GET /projects/:id/sessions` → `read` → list (updatedAt desc).
`SESS-5` `GET /projects/:id/sessions/:sid` → `read` → 200; non-uuid `sid` → 400.
`SESS-6` `PATCH /projects/:id/sessions/:sid {name?,metadata?}` → `session` (any project member, M_VIEWER included); attempting `status`/`sandbox_url`/`error`/`opencode_session_id` → 400 (server-managed); any other field → 400 (not user-editable). `name` sets a sticky USER override stored in `metadata.custom_name` (NOT clobbered by the server-side OpenCode title mirror, which only writes the auto title `metadata.name` during session reads); `name:""`/null clears it. Response `name` = resolved display (`custom_name ?? metadata.name`); `custom_name` exposed separately (authoritative override or null).
`SESS-7` `DELETE /projects/:id/sessions/:sid` → `session` (then **owner or project manager** only — `canManageLifecycle`, NOT `canManageSharing`; see `SESS-26` — a viewer can stop sessions they own) → 200 soft-delete status `stopped`; **remote branch preserved**.
`SESS-8` `GET /projects/:id/sessions/:sid/sandbox` → `read` → `session_sandboxes` row; **404 while row not yet inserted** (frontend polls); then status `provisioning`→`active` with `base_url`/`external_id`.
`SESS-9` `POST /projects/:id/sessions/:sid/restart` → `session` (then **owner or project manager** only — `canManageLifecycle`) → **202**; tears down container, revokes sandbox keys, re-provisions with rotated git/LLM/CLI tokens (status→`provisioning`); branch preserved.
`SESS-10` OpenCode title/tree mirror is server-owned. After a real prompt, the API snapshots the root OpenCode session and its child tree into `metadata.opencode_sessions`. `GET /projects/:id/sessions` and `GET /projects/:id/sessions/:sid` return the same root title and tree. No browser-write sync endpoint exists.
`SESS-12` `POST /projects/:id/sessions/:sid/stop` → `session` (then **owner or project manager** only — `canManageLifecycle`) → **200** status `stopped`, sandbox paused in place (disk kept, no re-provision — same contract as an idle auto-stop); resumable via `/start`/`SESS-9`. Sandbox not `active` → 409; unsupported provider → 400.
`SESS-13` Public shares — `GET/POST /projects/:id/sessions/:sid/public-shares` and `DELETE …/public-shares/:shareId`. LIST and DELETE are gated on `canManageLifecycle` (session owner or project manager); POST is gated on `canManageSharing` (the session owner, or a project manager when the session is machine-owned; see `SESS-14`). POST body `{preview:{port,path?,label?},file?,mode?,expires_at?}` → 201 `{share:{share_id,session_id,project_id,resource_type,label,port,path,file_path,mode,allow_websocket,expires_at,revoked_at,created_at,updated_at,public_token,public_path,proxy_path}}` (`public_token` = `kps_<shareId no dashes>`); a blocked/out-of-range port or an invalid `expires_at` → 400. GET list → `{shares:[…]}`, **not filtered** — a revoked share stays in the list with `revoked_at` set (revoking never deletes the row). DELETE `:shareId` → 200 `{share:{…,revoked_at}}`; **no idempotency guard** — revoking an already-revoked share is 200 again, not 409; unknown `shareId` → 404; non-uuid `sid`/`shareId` → 400. The unauthenticated counterpart is `GET /p/public-share/:token` (§9, mounted public — no auth middleware at all): unknown token → 404 `Share link not found`; **revoked token → 410** `Share link revoked` (checked before the sandbox); a real token whose sandbox has no `external_id` yet → 503 `Sandbox is not ready` (`resolvePublicShare` LEFT JOINs `session_sandboxes` for exactly this case — a freshly-created, not-yet-provisioned session has no sandbox row at all; an INNER JOIN previously misread that as a 404 "not found" on a perfectly valid token); a resolvable `preview` share proxies to `GET {origin}/p/public-share/:token/:port/*` (redirect for the bare `:port` form), a `file` share to `.../file[/*]` (view-only — non-GET/HEAD/OPTIONS → 405).
`SESS-14` Public-share access gate (`loadSessionForSharing()` — projects/lib/access.ts; **not** `loadVisibleSession()`, which gates on session-content visibility and 404'd a default-`private` session before any permission check ran, even for a real project manager). It returns TWO verdicts and the three routes do not share one:

- **`canManageLifecycle = isOwner || canManageProject`** gates LIST and DELETE. Revoking only ever REMOVES access, so a project manager must be able to kill a leaking link on a session they did not create.
- **`canManageSharing`** (`mayManageSessionSharing`, connectors/share.ts) gates POST. A public share link is UNAUTHENTICATED: a manager minting one against a private session they cannot read would hand themselves the content the visibility gate denied them. So the session **creator** may mint; a project **manager** who did not create it → **403 `"Only the session owner can create a public link to this session"`**, unless `created_by` names a service account (a trigger/agent run), where the manager governs because no human owner exists.

A project **member who is not the creator** → 403 on all three (`"Only the session owner or a project manager can …"`, a real permission denial — they're a legitimate project member, so there's nothing to 404-hide); NONMEMBER → 403 (account-membership gate, before the sharing check); ANON → 401.

`SESS-26` Session sharing policy is OWNER-governed — `PUT /projects/:id/sessions/:sid/sharing` (`loadVisibleSession().canManageSharing`, the same `mayManageSessionSharing` predicate as `SESS-14`'s POST). The session **creator** sets it. A project **manager** who did not create it → **403 `"Only the session owner can change who opens this session"`**. This route sits BEHIND the content-visibility gate, so a manager never reaches another human's still-private session at all (**404**, `loadVisibleSession`); the 403 is what they get on a session that WAS shared with them — project-wide or on its allow-list — which is exactly where a manager could previously rewrite the owner's policy and revoke everyone, the owner included. A plain project **member** → 404 or 403 (404 while the session is private, since it is invisible to them). ANON → 401.

A **machine-owned** session (`created_by` is a service account, or null) admits the project manager instead: `TRG-14`'s trigger sessions must stay governable, and owner-only would freeze their policy forever. `created_by` naming a removed/stale user stays owner-only — fail closed.

A sharing change must never remove the EDITOR's own access: `{mode:'private'}` from a non-owner → **400 `"That would remove your own access to this session. Add yourself, or share it with the whole project."`**, and so does `{mode:'members'}` whose member/group list omits the editor. `private` means "the OWNER only", so saving it as a non-owner revoked the editor's access with no undo — the undo needs the read the save had just revoked. Owners are structurally unaffected: every mode keeps the owner, so only a manager editing a machine-owned session can reach this 400.

The session payload reports both verdicts, and a client must not read one for the other: **`can_manage_sharing`** (may I change who can open it) and **`can_manage_lifecycle`** (may I stop / restart / delete it and change its model — `SESS-7`, `SESS-9`, `SESS-12`, and session reload). A project manager viewing another member's session gets `false` and `true` respectively.

`SESS-15` `GET /projects/:id/sessions/:sid/audit` → `read` + session-visible → 200 `{session_id,agent,audit_access,count,actions:[{execution_id,action,connector_id,status,risk,acted_by,acted_by_email,resolved_by,resolved_by_email,result_summary,at,resolved_at}]}` (most-recent-first, `?limit=` 1–1000, default 200; invalid `limit` → 400). This is the always-on approval control plane the launcher polls from every open session — non-Enterprise accounts (`auditAccess` entitlement off) degrade to **unresolved pending approvals only**, never a 402. Non-uuid `sid` → 400; NONMEMBER → 403; ANON → 401.
`SESS-16` Anonymous session-share VIEWING — `GET /public/session-shares/:shareId` and `GET /public/session-shares/:shareId/messages` (mounted public, `apps/api/src/public-session-shares/`; rate-limited by share id via `createPublicSessionShareRateLimitMiddleware`). `:shareId` is the SESS-13 share's raw `share_id` (uuid), NOT the `kps_` token — the route derives the token server-side (`publicShareToken(shareId)`) and resolves through the same `resolvePublicShare()` (identical 404/410/503 semantics; ANY existing share resourceType, `preview` or `file`, unlocks the view). `GET /:shareId` → 200 `{share:{share_id,session_id,project_id,resource_type,label,sandbox_status,expires_at},session:{session_id,title,status,created_at,updated_at}}`; DB-only, no sandbox round-trip. `GET /:shareId/messages` → 200 `{available,reason,opencode_session_id,message_count,messages:[{role,created,completed,text,tools:[{tool,status}],files:[{filename,mime}],reasoning_omitted}]}` — a sanitized, text-only digest fetched server-to-sandbox (no client-side sandbox access); 503 `"Sandbox is not running"` when the session's sandbox row isn't `active`, otherwise degrades to `available:false` (still 200) for a transient not-ready OpenCode daemon rather than erroring. Non-uuid `shareId` → 400.
`SESS-21` `GET|PUT /projects/:id/sessions/:sid/scope` and `PUT /projects/:id/sessions/:sid/model` hide an unknown project with 404.
`SESS-22` `GET|POST /projects/:id/sessions/:sid/question` hides an unknown project with 404.
`SESS-23` Park → wake → send (T18, session-middle-stop). `POST /projects/:id/sessions/:sid/stop` now aborts the session's live turn BEFORE powering the sandbox off (`abortLiveTurnBeforeStop`, T11) — closing the turn cleanly instead of leaving it to power off mid-run. Waking the box back up via `/start` and sending a new prompt must deliver that new prompt **exactly once**: the original prompt is never redelivered as a new message (same user-message ids across the wake), and the abort-stamp count observed on the old turn right after the wake — before any new prompt is sent — equals the pre-stop baseline exactly; sending the new prompt must not add a further "Interrupted"/abort stamp on top of it (the repeated-Interrupted regression this branch fixes). Exercised at the OpenCode message level through the preview proxy (no Kortix-level session-scoped abort route exists — `/stop`'s abort is a server-to-daemon `POST {sandbox}/kortix/abort` call, never reachable from an external client).
`SESS-24` Rapid API-level session switch (T18). Two sessions in one project, alternated: a `ready` session's second `/start` within 30s returns the same sandbox identity (`external_id`) as its first; alternating `/start` between two sessions never returns one session's sandbox identity for the other; each session's live `GET .../transcript` contains only its own reply, never the other session's (no cross-bleed). After `POST .../stop`, `GET /projects/:id/sessions/:sid` (the DB-backed detail read — the exact server-owned `opencode_sessions`/`name` mirror the web's "persisted-pin paint" instant-switch fix reads) keeps serving that session's own mirrored title/tree unchanged, proving the cached-paint read path works without a live runtime; `GET .../transcript` on the same now-stopped session instead degrades gracefully to 200 `{available:false}` (it is sandbox-backed, not DB-only, so it does NOT keep serving live content once stopped — this is the documented boundary, not a bug). A second, still-running session in the same project is unaffected by the first one's stop.

`SESS-25` Server-side prompt inbox. `POST /projects/:id/sessions/:sid/prompts` with a client-minted OpenCode wire `message_id` → `202 {prompt_id, state:'queued', message_id, deduped:false}`; the prompt is a DURABLE row in `kortix.session_lifecycle_commands` from that instant, so it survives a closed tab, a second device, and a crash. A `message_id` OpenCode cannot order → `400` (a mis-ordered id reads as already answered and the turn silently never runs). Re-POSTing the SAME `client_message_id` → `200 {deduped:true}` naming the SAME `prompt_id`, enforced by the unique index on `idempotency_key`. `GET .../prompts` lists what the session still owes the user — `queued` / `waiting` (with `reason`: `older_prompt_pending` or `held`) / `delivering` (with `reason: 'forwarded'` once it is at OpenCode but no turn has consumed it yet) / `failed`; a CONSUMED prompt is omitted, because it is in the transcript, and a live turn no longer holds a prompt back at all — OpenCode persists a mid-turn prompt and runs it in arrival order, and an automation's own `continue_session` row (trigger, Slack, approval resume) is never listed, deletable, or retryable here. `POST .../prompts/:promptId/retry` is the ONE primitive behind retry and "send now": it re-queues a `queued`/`failed`/`dead_lettered` row — or a STOP-PAUSED one, which is the row the hold is rendered on — RE-MINTED above the transcript (a stale id reads as already answered), promotes it past the ordering gate, releases the session's hold, and `404`s a row already on the wire. A row that has already been POSTed goes out under a NEW idempotency key, so the proxy's 10-minute delivery claim cannot answer it `duplicate` and swallow it. `POST .../prompts/hold {held:boolean}` is what the Stop button writes — every queued prompt of the session reads `waiting`/`held` until an explicit send or send-now releases it; a non-boolean is `400`. `DELETE .../prompts/:promptId` removes a prompt that has not gone out (`204`), refuses one already on the wire (`409` — cancelling it would be a lie), and never addresses another session's row (`404`).

---

## 8. Sandbox lifecycle + snapshots

`SNAP-1` `GET /projects/:id/snapshots` → `read` → list `kortix-snap-…` images per baseRef. **Session boot requires a `ready` snapshot of baseRef** (no shared fallback → session `failed` if none).
`SNAP-2` `POST /projects/:id/snapshots/rebuild` → **`manage` AND account `ACCOUNT_WRITE` (owner/admin)** → rebuild image. A project `manager` who is not owner/admin → 403; M_EDITOR → 403.
**No standalone sandbox create/stop routes exist.** Sandbox create/start is implicit
on session create (`provisionSessionSandbox`), asserted transitively by `RUN-1` /
`GOLD-1`. Manual stop = `SESS-12` (pauses in place, resumable); destructive teardown =
session `DELETE` (`SESS-7`); restart = `SESS-9`; status read = `SESS-8`. These are
documented boundaries, not flow ids: they carry no HTTP surface of their own.

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
`RUN-9` Stop → immediate send (T18, session-middle-stop). Abort a running turn through OpenCode's OWN `/session/<ocId>/abort` (the client-invoked runtime abort route the web "Stop" button calls — the same call `RUN-5` exercises), then, with NO settling delay, send a second, distinct prompt on the same conversation. The second turn's reply must address ONLY the second prompt — no bled-in content from the aborted first turn (the duplicate-streaming class of bug the branch's delta event-id idempotency fix targets) — and the first turn's own last assistant message must be left properly finalized: an abort `error` present AND `time.completed` set, never a dangling, never-completed row (the historical cause of a phantom "Interrupted" marker, T11).

---

## 10. Files (read via git API; write via sandbox)

Repo files are read-only over the project API; live edits happen in the sandbox (OpenCode file API via proxy) or via manifest commits. All git reads are `read`.

`FILE-1` `GET /projects/:id/files?ref=&path=` → file/dir listing.
`FILE-2` `GET /projects/:id/files/content?path=&ref=` → file text; **absent `path` param → 400**; non-existent file path is uncaught → surfaces 500 (not 404).
`FILE-3` `GET /projects/:id/files/search?q=&content=1&ref=&limit=` → filename + grep.
`FILE-4` `GET /projects/:id/files/history?path=` → commit history for path.
`FILE-5` `GET /projects/:id/files/archive?path=&ref=` → zip stream.
`FILE-6` `GET /projects/:id/branches` → authoritative remote branch refs without cloning repository history. A warm server mirror can add commit metadata and ahead/behind counts. Cold responses keep those optional display fields empty or `null`.
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

`RV-1` OWNER enables `review_center` through `PATCH /projects/:id/features`, then `GET /projects/:id/review/items?segment=needs_you|waiting|done&kind=…` → `read` → `{review_items:[…]}`. Invalid `segment` → 400; invalid `kind` → 400.
`RV-2` OWNER enables `review_center`, then `GET …/review/items/:reviewItemId` → `read` → `{review_item:{…}}`; unknown id → 404.
`RV-3` OWNER enables `review_center`, then `POST …/review/items {kind(output|decision|batch),title,summary?,risk?,detail?,agent?,session_id?}` → `read` + agent scope `project.review.submit` → 201. Missing `title` → 400; non-submittable `kind` (e.g. `change`) → 400; invalid `risk` → 400.
`RV-4` OWNER enables `review_center`, then `POST …/review/items/:reviewItemId/act {verdict(approve|reject|changes|answer|dismiss),feedback?}` → `write` + `project.review.act` → 200 updated item; invalid `verdict` → 400; unknown id → 404; adapted (`cr:…`) id → 409 (act from the source view). The list read-model also folds in Change Requests as `kind:change` items (id `cr:<crId>`).
`RV-5` OWNER enables `review_center`, then `POST …/review/bulk {ids:[…],verdict}` → `write` + `project.review.act` → 200 `{updated,review_items}`; empty/missing `ids` → 400.
`RV-6` access: NONMEMBER list → 403/404; ANON list → 401.

---

## 12. Triggers (cron + webhook + monitor; source of truth = `kortix.yaml`)

Specs in `[[triggers]]`; CRUD commits the manifest; runtime state and account-local session access live in `project_trigger_runtime`. Types: `cron`, `webhook`, `monitor` (experimental, behind the `monitors` feature flag — see `docs/specs/2026-08-12-monitors.md`). A `monitor` entry requires `run` + `mode` (`poll`|`stream`; `interval` ≥30s required iff `poll`, rejected on `stream`), rejects cron/webhook-only fields (`cron`, `schedule`, `run_at`, `timezone`, `secret_env`), and defaults `session_mode` to `reuse`. Monitor FIRING is not an end-user HTTP surface: the per-project monitor box posts to `POST /projects/:id/monitors/ingest` with its own sandbox token (coverage-allowlisted; auth/dedup/rate-limit behavior pinned in `apps/api/src/__tests__/unit-monitor-ingest-route.test.ts`), and `drainMonitorEvents` hands events to `fireGitTrigger` on the scheduler tick, beside the trigger execution queue. The local test profile excludes cloud sandboxes, so the box lifecycle is covered by unit tests plus the live verification recorded in the spec doc.

`TRG-1` `GET /projects/:id/triggers` → `read` + leaf `project.trigger.read` → specs + `last_fired_at` + parse `errors` + `webhook_url`; non-member 403/404; ANON 401.
`TRG-2` `POST /projects/:id/triggers {name(required),slug?,type,agent?,enabled?,prompt_template,cron?,timezone?,secret_env?}` → `manage` → 201, manifest committed; `name` is required (slug derived from it when omitted); duplicate slug → 409. `webhook` requires `secret_env` (names a `project_secrets` key, regex `^[A-Z_][A-Z0-9_]*$`). `cron` requires 6-field croner expr + IANA `timezone` (default UTC).
`TRG-3` `PATCH /projects/:id/triggers/:slug` (e.g. `{enabled:false}`) → `manage`.
`TRG-4` `DELETE /projects/:id/triggers/:slug` → `manage` (also drops runtime row).
`TRG-5` `POST /projects/:id/triggers/:slug/fire` → `manage` → manual fire → 202 `{status:fired,session_id}`; under backpressure → 202 `{status:queued,reason}`.
`TRG-7` webhook fire — `POST /webhooks/projects/:id/:slug` (**public, HMAC**). Sig header `X-Kortix-Signature` or `X-Hub-Signature-256` (`sha256=` stripped), HMAC-SHA256 over raw body vs `project_secrets[secret_env]`, constant-time. Valid → 202 fired/queued; malformed UUID/slug → 400; unknown project → 404; bad sig → 401; missing secret → 409; unknown/disabled/non-webhook trigger → 404; fire failure → 500.
`TRG-10` `GET /projects/:id/triggers` leaf gate — a member bound to a custom (Enterprise) project role granting `project.read` but NOT `project.trigger.read` loads the project yet is rejected 403 at `GET /triggers` (the `assertProjectCapability(project.trigger.read)` fires after the read passes); a floor `user` member (built-in role carries `project.trigger.read`) still gets 200. Scoped-agent-token variant proven at the API layer in `integration-project-read-leaf-gates-http.test.ts`.
`TRG-11` Triggers CRUD authz boundaries — `ANON → 401` on POST/PATCH/DELETE/fire/activation; a project `member` (floor role) holds `trigger.read` + `trigger.fire` but NOT `project.write` (the `manage` floor) nor `trigger.create/update/delete` → `GET 200`, `POST/PATCH/DELETE/activation 403`, `fire` unknown-slug `404` (NOT 403 — the fire leaf passes; the 404 is the slug lookup).
`TRG-12` `POST /projects/:id/triggers` input validation — missing `name`/`type`/`prompt_template` → `400`; bad `type` (not cron/webhook) → `400`; invalid `session_mode` → `400`; `pinned` without `session_id` → `400`; `pinned` with a `session_id` from another project → `400`; webhook without `secret_env` → `400`; webhook with bad `secret_env` (lowercase / leading digit, not `^[A-Z_][A-Z0-9_]*$`) → `400`; cron without `cron` AND without `run_at` → `400`; cron with non-ISO `run_at` → `400`; explicit invalid slug (uppercase / leading dash, not `^[a-z0-9][a-z0-9_-]{0,127}$`) → `400`.
`TRG-13` `PATCH`/`DELETE`/`activation` edge cases — PATCH unknown slug → `404`; PATCH no-op body `{}` → `200` (no manifest keys, no git commit); DELETE unknown slug → `404`; DELETE invalid slug format (uppercase / leading dash) → `400` (regex gate before manifest lookup); activation pause→resume round-trip persisted on readback (`triggers_paused`); activation non-boolean / missing `paused` → `400`.
`TRG-14` trigger-created session access — omitted `session_access` defaults to `{mode:'private',memberIds:[],groupIds:[]}`. The trigger agent service account owns created sessions. Project managers, account owners, and account admins can open and discover trigger-created sessions in every mode. An ordinary member cannot open or discover a private trigger session without an explicit member/group grant. A project manager cannot open or discover an ordinary private human session. No session inventory returns a row the caller cannot open. The sidebar, sessions page, and command palette render `Shared` on every accessible session whose `is_owner` value is false. They leave the viewer's own sessions unmarked. The ownership marker remains visible beside the session source. Session POST and PATCH reject client-supplied `source`, `trigger_kind`, and `trigger_slug` metadata, so a human session cannot forge trigger attribution. `PATCH {session_access}` accepts `private`, selected `members`, or `project`. Selected member/group ids must belong to the trigger account. Unknown or cross-account ids → `400`. Duplicate ids are removed. Empty selected access normalizes to private. Policy-only PATCH does not commit `kortix.yaml`. Saving a policy also updates prior sessions created by that trigger. Pinned sessions retain their own session sharing policy. Trigger deletion cascades its access grants.

**Trigger behavior with no black-box HTTP surface.** These are documented
boundaries, not flow ids.

- *Cron scheduler* — global `setInterval` (default 60s), sweeps ≤200 active
  projects; due = `nextCronRun(cron,lastFired,tz) ≤ now`; **marks fired BEFORE
  firing** (no double-spawn per slot). Disabled via
  `KORTIX_TRIGGER_SCHEDULER_ENABLED=false`. It is a background sweep, not a
  route; `apps/api/scripts/e2e-triggers-live.sh` drives it against wall-clock.
- *fire→run* — `fireGitTrigger` → provisioning actor = account owner, initial
  `visibility:'private'`, then a durable post-create action resolves the trigger
  agent service account and current account-local policy. The action sets
  `created_by`, visibility, and member/group grants. Queued creates resolve the
  policy when the worker runs. Backpressure: provisioning sessions ≥3 OR account
  at tier cap → queued. The fire entrypoints are asserted by `TRG-5` / `TRG-7`;
  the run itself needs the `funded` capability.
- *No inbound GitHub event webhook exists.* Simulate "GitHub Actions"-style
  automation as a generic `webhook` trigger; a GitHub repo webhook can drive it
  if its secret == `secret_env` (via `X-Hub-Signature-256`). The generic webhook
  fire boundary is covered by `TRG-7`.

---

## 13. Channels (Slack / Telegram / Email)

Tokens stored as encrypted project secrets; webhooks public + signature-gated.

`CHN-1` `kortix channels connect --bot-token xoxb-… --signing-secret …` (manual/BYO mode) → validates `xoxb-` via `auth.test` → `POST /projects/:id/channels/slack/connect` (`manage`) → 200, prints webhook `$API/webhooks/slack/:id`.
`CHN-1b` `kortix channels connect` (no creds) → `GET /projects/:id/channels/slack/mode` (`read`) → `{oauth_available, install_url}`; when available the CLI prints the pre-signed one-click "Add to Slack" URL (signed `state`, 10-min TTL — same flow as CHN-7) instead of manual mode.
`CHN-2` `GET /projects/:id/channels/slack/installation` → `read` → workspace/team/bot/url or "not connected".
`CHN-3` `DELETE /projects/:id/channels/slack/installation` → `manage`.
`CHN-4` Slack inbound (OAuth mode) — `POST /webhooks/slack` (shared `SLACK_SIGNING_SECRET`): `v0=HMAC(v0:{ts}:{body})`, ±5min replay window; `url_verification` → echo `challenge`; `event_callback` routed by `team_id`→binding→project.
`CHN-5` Slack inbound (BYO mode) — `POST /webhooks/slack/:id` (unsigned `url_verification` bootstrap → 200 challenge before installation; real callbacks require the per-project signing secret).
`CHN-6` Slack dispatch — `app_mention`/IM/threaded `message` → existing thread session → deliver to sandbox `/kortix/prompt` (`delivered|transient|stale`); else `createProjectSession` (actor=owner, agent `default`, `visibility:'project'` — channel sessions are team-visible) + record `chat_threads`.
`CHN-7` Slack OAuth — `GET /webhooks/slack/oauth/callback` (signed `state`, 10-min TTL) → exchange code → `saveSlackInstall`.
`CHN-8` Telegram inbound — `POST /webhooks/telegram/:id`: verify `x-telegram-bot-api-secret-token` (missing→404, mismatch→401) → `message`/`edited_message` → spawn session (actor=owner, `visibility:'project'`).
`CHN-9` bad sig on any channel webhook → 401. Not configured → **503 (Slack OAuth mode + OAuth callback)** but **404 (Slack BYO + Telegram)**.
`CHN-13` `POST /projects/:id/channels/email/connect {connector_slug?}` → `manage` + project experimental `agentmail_email` enabled → creates or attaches an AgentMail inbox + `message.received`/`message.received.unauthenticated` webhook, stores inbox/webhook metadata as encrypted per-connection project secrets, and marks that Email connector connected. Disabled projects return 403 before AgentMail key validation. Omit `connector_slug` for legacy `kortix_email`; provide an Email connector slug for multiple inboxes.
`CHN-14` `GET /projects/:id/channels/email/installation?connector_slug=...` → `read` → AgentMail inbox id/email/webhook id for that connection or null; disabled projects return null.
`CHN-15` `DELETE /projects/:id/channels/email/installation?connector_slug=...` → `manage` → removes that connection's inbox binding.
`CHN-16` AgentMail inbound — `POST /webhooks/email/agentmail`: Svix `svix-*` signature verified against the per-project webhook secret when configured; AgentMail's real unwrapped `message.received` or `message.received.unauthenticated` payload routes by `message.inbox_id` → project, maps `thread_id` 1:1 to a Kortix session, and follow-up emails continue that session.
`CHN-17` `GET /projects/:id/channels/email/mode` → `read` → `{provider:"agentmail",enabled:boolean,managed_available:boolean}` so the UI can hide Email until `agentmail_email` is enabled and require a project AgentMail key when no managed server key exists.
`CHN-18` `GET /projects/:id/channels/bindings` → `read` → `{projectDefaultAgent, bindings:[{bindingId,platform,workspaceId,channelId,channelName,channelType,agentName,opencodeModel,conversationPolicy,installedAt,effectiveAgent:{agent,source}}]}` — the web management surface for `chat_channel_bindings` (today populated only via Slack `/kortix agent|model|policy`); `effectiveAgent` resolves `agentName ?? project default ?? 'default'` the same way the Slack panel does.
`CHN-19` `PATCH /projects/:id/channels/bindings/:bindingId {agentName?,opencodeModel?,conversationPolicy?}` → `project.connector.write` (no dedicated channel-binding leaf exists; reuses the same capability that gates connecting/disconnecting the channel itself) → updates via the same `setChannelAgent`/`setChannelModel`/`setChannelConversationPolicy` helpers the Slack commands call; `agentName` validated against the project's declared `[[agents]]` when adopted (any name accepted for a legacy/undeclared project), `null` resets to the project default, `"default"` is an alias for `null`; `opencodeModel` validated via `isModelServableForAccount` (409 `model_not_servable` when not servable) and normalized to the opencode `kortix/…` ref before storing; unknown `bindingId` → 404 before body validation; empty body on an existing binding → 400 `empty_patch`.
`CHN-20` send-primitive IAM gate — `POST /projects/:id/channels/slack/file/upload` posts to a channel with the project's bot credentials and asserts leaf `project.connector.write` (IAM enforcement audit; previously gated by project-read only, so any read-capable caller could drive them). A floor `user` member (project.read, no connector.write) → 403 before any Slack call; a `manager` (holds connector.write) passes the gate (200/400/404/502/503, never 403); non-member 403/404; ANON 401. The `channel.*` catalog leaves were removed (never wired to a route). Scoped-agent-token variant proven at the API layer in `integration-project-read-leaf-gates-http.test.ts`. (The former `meet/speak` half of this gate went away with the notetaker — see §VOICE.)
### Voice (live calls) — §VOICE

The agent starts a live voice call bound to its session and hands out a join link — it does not join a third-party meeting. Whoever opens the link lands on a plain LiveKit client page (`/voice/:token`, public); the realtime provider connection is held SERVER-side (apps/voice-agent), so no provider credential or session authority ever reaches that page. Per-project bot name lives in `projects.metadata.meet`.

**Two surfaces exist and they point in opposite directions.** Keeping them straight is the whole of this section:

- **The Kortix agent's side is the `kortix_voice` CONNECTOR** — `spawn_room`, `read_transcript`, `send_prompt`, `end_call`, plus `join_gmeet`/`join_zoom` which are declared for a stable surface but deliberately not implemented (calling either returns a clear `not_implemented` error, never a silent no-op). These are `{kind:'voice'}` bindings executed by the API's own server-side code (`connector/db-deps.ts`'s `executeVoiceCall`), routed through the connector gateway like every other connector, so policies, approvals and the audit trail apply. The connector is materialized per-project only when the `voice` experimental flag is on (`connector/channel-materialize.ts`). It has **no HTTP route of its own** — it is covered by the connector catalog flows, not by a voice flow. It used to be an MCP at `POST /projects/:id/mcp/voice`; **that route no longer exists.**
- **The LiveKit worker's side is the voice MCP**, `POST /projects/:id/sessions/:sid/mcp/voice`, serving `ask_kortix` / `run_command` / `post_turn`. `ask_kortix` returns the instant the request is queued and refuses a second while one is unanswered; `run_command` is bounded by a short server-side timeout and reports `timed_out`; `post_turn` persists one transcript line. No follow/tail/stream tool exists, by design. Unknown JSON-RPC method → `-32601`; a tool that throws surfaces as a tool-error RESULT, not a protocol error, so the caller can read and react to it. That tool half is only reachable holding a per-call HMAC minted server-side, so it is proven in apps/api's own tests — the flow here asserts the boundary.

`VOICE-1` `PUT /projects/:id/channels/meet/name {name}` → `manage` → sets the bot's display name in the call (default "Kortix"); NONMEMBER → 403/404; ANON → 401.
`VOICE-2` `POST /projects/:id/sessions/:sid/mcp/voice` — the worker MCP's auth boundary. Authed ONLY by the per-call `kortix_api_token`: an HMAC over the call id (the call id IS the session id), minted server-side in `startCall` and delivered to the worker in the LiveKit room metadata (`channels/voice/worker-token.ts`). It is NOT session/PAT auth, and the route is mounted BEFORE `projectsApp` precisely so `supabaseAuth` never claims it. ANON → 401; an OWNER session → 401; an account PAT → 401; a forged 64-hex bearer → 401 (the HMAC compare is length-guarded and timing-safe). Auth is checked BEFORE the body, so a malformed JSON-RPC payload from an unauthenticated caller is still 401 — never 400, never 500.
`VOICE-3` `GET /projects/:id/sessions/:sid/voice-transcript[?cursor&limit]` — a Kortix-authenticated read of the same durable record (`voice_call_turns`), for the web app. Project `read` + the session must be visible to the caller; explicitly NOT the worker's per-call HMAC. Non-uuid session id → 400; unparseable `cursor` → 400; unknown session → 404; NONMEMBER → 403/404; ANON → 401.
`VOICE-4` Same route, happy path: a session that has never had a call → 200 `{session_id, call_id, live:false, cursor, count:0, turns:[]}` — an empty transcript, never a 404. `call_id === session_id`. `role` alone does not identify a turn: `user`+null is a human, `agent`+`kortix` is what the Kortix agent put into the call, `agent`+bot-name is what the voice said, `tool`+tool-name is an `ask_kortix`/`run_command`. Ordering is the monotonic `voice_call_turns.cursor`, never `created_at` (two turns can share a millisecond and a wall-clock tie would silently drop one).
`VOICE-5` `GET /public/voice-join/:token` — PUBLIC and unauthenticated by design: a join link IS the capability (256 bits of `randomBytes`, `vjl_`-prefixed, hashed at rest), and requiring login would defeat handing it to someone outside the account. Resolves to `{call_id, url, token}` with a FRESHLY minted LiveKit access token each time. Unknown/garbage/never-issued token → 404 (indistinguishable from each other); a project id or a bare uuid is not a join token → 404, never 401. Revoked (the call ended) or expired → 410 — that half needs a real call to end and is proven against the real route + DB in apps/api's `integration-voice-join-links.test.ts`.
`VOICE-6` `GET /public/voice-join/:token/transcript[?cursor&limit]` — the same join-link capability, strictly less power: transcript text for the ONE call the link was minted for, never a LiveKit token. Deliberately takes NO project or session id — `resolveJoinLink` yields the call id and nothing the caller wrote reaches `readTurns`, so there is no id for an anonymous caller to swap for someone else's call; the project id is not echoed back either. Unknown token → 404 even with `call_id`/`session_id`/`project_id` query parameters attached. A mangled `cursor`/`limit` is CLAMPED, not rejected (a link truncated in a chat client must still show the call), so it never turns into a 400. Both public routes are IP-keyed rate limited (resolve 30/min, transcript poll 120/min — the poller cannot share the resolve budget).

---

## 14. GitHub integration + `kortix ship`/`deploy`

GitHub is **outbound only** (repo create, Contents API commits, installation-token git transport). No inbound event receiver.

### GitHub App install (account-level, dashboard)

`GH-1` `GET /projects/github/installation?account_id=` → `ACCOUNT_WRITE` → 200; if none → returns `install_url` (`github.com/apps/<slug>/installations/new?state=<hmac>`), state row TTL 30min.
`GH-2` user installs on GitHub → redirect → `$WEB/github/setup?installation_id=&state=&setup_action=install` → `POST /projects/github/installation {state,installation_id}` → verify HMAC + iat window + one-time nonce consume → fetch real owner via `GET api.github.com/app/installations/{id}` → upsert `account_github_installations`.
`GH-3` `DELETE /projects/github/installation?account_id=` → `ACCOUNT_WRITE` → disconnect. `setup_action=uninstall` → frontend "removed".
`GH-4` Supabase GitHub OAuth popup (user token, distinct from App) — `signInWithOAuth(github, scopes 'read:user read:org')`, `provider_token` posted back to opener; `POST /projects/github/installations/linkable {account_id,github_user_token}` lists this App's installations with the App JWT and returns only the authorized personal owner or active organization-admin installations; `POST /projects/github/installations/link {account_id,installation_id,github_user_token}` re-verifies App ownership plus GitHub authority before upsert.
`GH-5` git transport resolution (`resolveProjectGitAuth`): managed GitHub (fresh repo-scoped installation token) / GitHub App / `project_secret` token / server PAT / none.
`GH-6` `PUT /projects/:id/git-credential` (BYO) → `manage` → set git auth secret; already server-managed → 409.
`GH-7` `POST /projects/:id/git-token` → mint a fresh managed-GitHub installation token; **409 for BYO**; 503 if managed Git is unavailable.
`GH-8` `GET/POST/DELETE /projects/:id/cli-token[/:tokenId]` → project-scoped CLI tokens.

### `kortix ship` (alias `deploy`)

`SHIP-1` first ship, no `origin` → managed: `POST /projects/provision` → set `origin` to the managed GitHub URL, commit, header-injected token push, write `link.json`. Requires `PROJECT_CREATE`.
`SHIP-2` first ship, existing `origin` → **BYO** (single-writable-origin rule): `POST /projects {repo_url,name}`, **origin never modified**, push with user's own creds. **NB: the API's BYO `POST /projects` only accepts a GitHub repo_url** (`normalizeRepoUrl`→`resolveGitHubImport`); a non-GitHub origin is rejected 400 before `saveLink`, so ship exits non-zero, writes no link.json, and (proven) never clobbers the origin. The real happy path needs a live GitHub repo + App install.
`SHIP-3` first ship `--origin <git-url>` → BYO explicit; only this case rewrites `origin` (`git remote set-url`) — but `setOrigin` runs _after_ the POST, so a non-GitHub `--origin` 400s first → non-zero exit, no link.json, origin not rewritten (GitHub-only, as SHIP-2).
`SHIP-4` first ship `--origin managed` → force managed even if origin exists.
`SHIP-5` multiple accounts + no `--account`/`-y` → interactive pick; `--account <id|slug>` mismatch → error listing slugs.
`SHIP-6` subsequent ship (linked) → `GET /projects/:id` (403→access guidance, 404→gone guidance); managed → `POST /projects/:id/git-token` (fresh token per ship) → commit + push; BYO → `ensureOrigin` only if missing.
`SHIP-7` `kortix ship -n/--dry-run` → prints would-be calls, **no side effects**.
`SHIP-8` `kortix ship` outside a git repo or non-Kortix dir → error; not logged in → "run kortix login"; 503 → "managed git not configured; pass --origin <git-url>".
`SHIP-9` `--no-commit` with dirty tree → error; clean tree + HEAD → skip commit, push only.

### CLI resource commands (project-scoped)

`CLI-PROJ` `kortix projects ls|info|link|unlink|open|rm` → `GET /projects`, `GET /projects/:id`, `DELETE /projects/:id[?purge=true]` (`--purge` deletes the managed repo; BYO untouched).
`CLI-SESS` `kortix sessions ls|new|info|restart|rm|open` → maps to §7.
`CLI-SEC` `kortix secrets ls|set|unset` + `kortix env pull|push` → maps to §6 (values write-only).
`CLI-TRG` `kortix triggers ls|fire|enable|disable|info` → maps to §12.

---

## 15. Secrets / env

DB `project_secrets` (AES-256-GCM, key bound to `projectId`, unique `(project_id,name)`). **Write-only API — values never returned.**

`SEC-1` `GET /projects/:id/secrets` → `manage` → names only + manifest required/optional keys + virtual git-auth row.
`SEC-2` `POST /projects/:id/secrets {name,value}` → `manage` → upsert (encrypt); name upper-cased; invalid name format → 400; `KORTIX_*` reserved → 400. M_EDITOR/M_VIEWER → 403.
`SEC-3` `DELETE /projects/:id/secrets/:name` → `manage`; invalid name → 400; system secret (git-auth) → 403.
`SEC-4` injection — `buildSessionSandboxEnvVars` decrypts only `runtime` + `sandbox` secrets authorized by the immutable agent grant and current session allowlist. Denied and reserved platform credentials do not enter the project-secret environment; an egress-enforced secret enters it as a HANDLE, never as its value.
`SEC-6` `POST /projects/:id/secrets {identifier,name,value}` → two identifiers may share one env-var `name` (e.g. `GMAPS-primary`/`GMAPS-backup` both `GOOGLE_MAPS_API_KEY`); re-submitting an existing `identifier` with a different `name` → 409.
`SEC-8` `PUT /projects/:id/secrets/:identifier/strategy {strategy,consumer?,egress_policy?,handle_prefix?}` → manager-only control plane; `runtime|denied` → 200; `broker` accepts `llm_gateway|connector|http_broker`; only `http_broker` accepts and requires a validated `backend=kortix_fetch` policy. Generic `git_proxy` broker remains unavailable. Egress-enforced `egress` accepts exact-host policies with or without an `inject` slot on every sandbox provider (`network_boundary_available` is always true), and rejects unenforceable controls with 400. Each change revokes active HTTP broker handles and writes `secret.strategy.changed`; agent principals → 403. `POST /projects/:id/secrets/sync` requires secret write and re-applies current policy to active sessions. Its response reports `active_sandboxes`, `targeted`, `synced`, `failed`, `exported`, and one result per sandbox with the applied `scope`, `revision`, export counts, and `agent_env_written` proof. A partial delivery returns `ok:false`. `POST /projects/:id/secrets/:identifier/broker` accepts only a session-scoped agent token, intersects the immutable agent grant with the current session allowlist, requires an active revisioned handle, applies the stored HTTPS host/method/path/injection policy, and writes pending plus terminal audit events without request bodies, headers, query values, handles, or secret values.
`CONN-ATT-AUTH` `POST /connectors/[projects/:projectId/]attachments` → both attachment-upload forms require authentication before accepting multipart data; anonymous requests → 401.

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
`BILL-9` billing write ops (`create-checkout-session`/`create-per-seat-checkout`/`create-inline-checkout`/`confirm-inline-checkout`/`create-portal-session`/`claim-per-seat`/`cancel-subscription`/`reactivate-subscription`/`schedule-downgrade`/`cancel-scheduled-change`/`purchase-credits`/`auto-topup/configure`/`sync-subscription`/`sync-seat-quantity`/`confirm-checkout-session`) — auth boundary: ANON → 401; non-account-member → 403; account `MEMBER` (`billing.read` only) → 403. They require `billing.write` (OWNER + the `billing_manager` BILLING policy only; ADMIN/AUDITOR/MEMBER denied), enforced by `billing/require-billing-write.ts` (`resolveScopedAccountId` membership check + `assertAuthorized(billing.write)`) — so a non-billing teammate can't subscribe / cancel / top-up / reconcile seats / confirm a checkout on the account's behalf. Read-only ops (`proration-preview`, `checkout-session/:id`) stay member-accessible (membership only). **(finding 2026-06-04 RESOLVED 2026-06-11: the `billing.write` gate now exists in code; extended 2026-08-19 to `sync-subscription`, `sync-seat-quantity`, `confirm-checkout-session`, which mutate billing state and were still membership-only.)**
`BILL-13` The internal free-tier rotation cron runs through its authenticated route and returns processed, skipped, and error counts.
`BILL-16` The yearly credit rotation cron rejects missing and invalid internal credentials without mutating account credits.
`COST-1` `GET /usage/session-costs?account_id=&project_id=&limit=&offset=` → authenticated account member; project-derived account scope requires `project.gateway.spend.read`, otherwise → 403. Returns every matching session, including zero-cost sessions, as a paginated `{sessions,total,limit,offset,next_offset,reconciliation}` response. Each row combines finalized LLM cost, billed compute cost, owner, project, request, token, model, and compute-duration fields. `limit` defaults to 25 and accepts 1–100; invalid pagination → 400; ANON → 401. `GET /usage/session-costs/:sessionId?account_id=&project_id=` applies the same spend gate and returns the summary plus `model_usage` and discriminated `ledger_entries`; unknown, foreign, or project-mismatched session → 404. Sandbox tokens are rejected.

`COST-2` `GET /usage/cost-by-project?account_id=&from=&to=&sort=&limit=&offset=` → the project spend rollup behind the explorer's first level: same account/spend gate as `COST-1`, paginated `{projects,total,limit,offset,next_offset}`, sorts `total_desc|total_asc|recent|name_asc`. `GET /usage/cost-summary?account_id=&project_id=&session_id=&from=&to=` returns `{totals,previous,series,models}` for whichever scope is supplied, so one route serves all three levels; `series` is gap-filled with one point per UTC day so an empty day reads as zero rather than being skipped, and `previous` covers the equally long window immediately before. Windows are half-open `[from,to)` and always UTC; an inverted or over-long window → 400; ANON → 401. Both routes accept `format=csv`, which runs the same filtered query rather than the visible page, caps at 10,000 rows (reported in `x-kortix-row-cap`) and neutralises a leading `=`/`+`/`-`/`@` so a spreadsheet cannot evaluate a project name as a formula.

---

## 17. Router / LLM / proxy (sandbox-facing; `apiKeyAuth`)

`RTR-1` `POST /router/web-search {query}` · `POST /router/image-search` → `APIKEY` → 200; `ANON`/JWT → 401.
`RTR-2` `POST /router/chat/completions {model,messages,stream}` (OpenAI-compat) · `GET /router/models` · `GET /router/models/:model`.
`RTR-4` billed proxy passthrough `ALL /router/:service[/*]` for `tavily|serper|firecrawl|replicate|context7|anthropic|openai|xai|gemini|groq` — Kortix token → managed keys; user key + `X-Kortix-Token` → passthrough; disallowed service/route → 4xx.
`GW-1` standalone gateway `GET /health` → 200 `{status:"healthy",service:"kortix-llm-gateway"}`.
`GW-2` standalone gateway `GET /v1/llm/models` plus `/v1/models` and `/v1/openai/models` aliases — account PAT → 200 with a non-empty `{models:{...}}` catalog.
`GW-2b` An anonymous caller cannot list models through the standalone gateway.
`GW-3` standalone OpenAI-compatible chat aliases reject ANON → 401/403.
`GW-4` project LLM gateway routing policy — `GET /projects/:id/gateway/routing-policy` returns the persisted project document plus effective account/platform inheritance; `PUT` atomically saves project/vision defaults, a bounded ordered default chain, and exact-model overrides; `GET /projects/:id/model-picker` returns the compact connection-aware selector catalog while the full runtime catalog remains sandbox-only; `POST …/preview {requestedModel,imageInput}` resolves the finite route and model availability without consuming tokens; `DELETE` resets every project override. Duplicate/self-loop/`auto` fallback routes → 400 `invalid_routing_policy`; project nonmember → 403/404; ANON → 401.
`GW-5` `GET /projects/:id/llm-catalog/providers` returns the LIVE provider-level catalog (id/name/env/doc/models per provider) from the same 24h-refreshed runtimeModelCatalog `/llm-catalog` and `/model-picker` read — the source the web connect modal now consumes instead of a baked snapshot. Unlike `/llm-catalog`/`/model-picker`, NOT gated by the project's `llm_gateway` flag (the BYOK connect modal applies to native-mode projects too) → 200 for both gateway and native projects; project nonmember → 403/404; ANON → 401.
`GW-6` Anthropic-Messages-compatible ingress on the LLM gateway — `POST /v1/llm/messages` on the in-process mount (and the `/v1/...`-prefixed `POST /v1/llm/v1/messages` alias, mirroring `/v1/llm/chat/completions` vs `/v1/llm/v1/chat/completions`), plus `POST /v1/messages` / `POST /v1/llm/messages` / `POST /v1/openai/messages` on the standalone gateway pod (mirroring its `/v1/chat/completions` / `/v1/llm/chat/completions` / `/v1/openai/chat/completions` aliases) — accepts an Anthropic Messages-shaped body (`{model,system,messages,tools,max_tokens,stream}`) and routes it through the SAME `handleChatCompletions` pipeline as the OpenAI-compat surface — translation to/from Anthropic shape happens only at the edges, so auth/billing/routing/failover (and BYOK keys) are identical. Returns Anthropic-shaped JSON (non-streaming) or an Anthropic Messages SSE event stream (`message_start`/`content_block_start`/`content_block_delta`/`content_block_stop`/`message_delta`/`message_stop`) when `stream:true`, including `tool_use` content blocks for tool calls. ANON → 401/403. (The legacy `POST /router/messages` — a hardcoded-OpenRouter-key passthrough billed against the legacy LLM-credits ledger — has been removed; this gateway ingress is its replacement and the only `/messages`-shaped surface now.)
`GW-11` OpenRouter-parity account reads (`combinedAuth`) — `GET /generation?id=<requestId>` looks up one `gateway_request_logs` row by `requestId` scoped to the caller's account and returns `{ data: {...} }`; missing `id` → 400, unknown/foreign id → 404. `GET /usage[?start&end&group_by]` aggregates `usage_events` for the account into `{ data: {totals}, breakdown?: [...] }`; `group_by` one of `model|provider|day`; invalid `group_by` or `start`>`end` → 400. ANON → 401 on both.

---

## 18. Platform / OAuth2 provider / Tunnel / Deployments

### Platform

`PLT-1` `GET /platform/` → `{ok:true,message:"platform"}` (public). `GET /platform/sandbox/version[/latest|/all|/changelog]` (public).

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
`ADM-20` `GET /v1/admin/api/projects` → the fleet view: every project across every account, paged → 200 `{projects,total,page,limit}`. Query: `search` (project name / account name / any account member's email, ilike), `accountId`, `status` (csv of `project_status`), `sortBy` (`activity`|`created`|`sessions`), `sortDir`, `page`, `limit` (default 50, **capped at 100**). Each row carries `projectId`, `name`, `status`, `accountId`, `accountName`, `ownerEmail`, `createdAt`, `sessionCount`, `activeSessionCount` (status in `queued`/`branching`/`provisioning`/`running`), `lastSessionAt` (max session `created_at`, null when the project never ran one). Default sort is `activity` DESC **NULLS LAST**, so a never-run project sorts last in both directions. Two inputs are sanitized rather than passed to Postgres, which would answer 22P02: an unknown `status` value is dropped (filter degrades to "no status filter"), and a non-uuid `accountId` returns an **empty page** (`total:0`) rather than widening to every project. Non-admin → 403; ANON → 401.

#### Trials + entitlement overrides

An admin-issued **trial** makes an account BEHAVE as a paid tier — entitlements, project/session limits, managed-models — until it ends, **without writing `credit_accounts.tier`** (that column belongs to the Stripe webhook). Resolution is a lazy overlay, so a trial never masks a real subscription. Every write below is scoped to a fresh run-owned account, never a real customer.

`ADM-14` `POST /v1/admin/api/accounts/:id/trial {tier_key,seats,duration_days,note?,credit_grant?}` → grant or **replace** a trial (re-granting overwrites the window — extend/adjust = re-grant) → 200 `{ok:true,trial:{status:"active",tier,seats,startedAt,endsAt,note},credit_granted}`. `credit_grant` (USD credits, default 0) funds sandbox compute in the same call. Rejected with 400: `tier_key` that is not an existing **paid** tier (`free`/`none`/unknown), `seats` outside `[1,100]`, `duration_days` outside `[1,365]`, `credit_grant` outside `[0,10000]`. Non-admin → 403; ANON → 401. After a grant the `ADM-1` list row for the account reports `trial.status:"active"` with the granted tier/seats.
`ADM-15` `DELETE /v1/admin/api/accounts/:id/trial` → revoke immediately → 200 `{ok:true,trial:{status:"revoked",…}}`. Status-only: tier/seats/window stay on the row as the audit trail. No active trial (never granted, or already revoked/expired) → **400**. Non-admin → 403; ANON → 401.
`ADM-16` `POST /v1/admin/api/accounts/:id/managed-models {override}` → tri-state managed-models entitlement override → 200 `{ok:true,override}`. `true` grants Kortix-credential models regardless of tier, `false` forces BYOK-only, `null` restores "the effective tier decides". Neither boolean nor null → 400; non-admin → 403; ANON → 401.
`ADM-17` `POST /v1/admin/api/accounts/:id/enterprise-demo {enabled}` → the operator counterpart of `IAM-32`'s retired self-serve toggle → 200 `{ok:true,enabled}`; same `credit_accounts.demo_enterprise` storage and the same entitlement effect, so `IAM-32`'s GET reflects it immediately. Non-boolean → 400; non-admin → 403; ANON → 401.
`ADM-18` `GET /v1/admin/api/accounts` rows carry the entitlement columns the console renders: `billingModel`, `seatCount`, `trial:{status,tier,seats,startedAt,endsAt,note}`, `managedModelsOverride`, `demoEnterprise`, `enterpriseEntitled`. A never-granted account reads `trial.status:"none"` with null tier/seats/window, `managedModelsOverride:null`, `demoEnterprise:false`, `enterpriseEntitled:false`. Non-admin → 403; ANON → 401.
`ADM-23` `PUT /v1/admin/api/accounts/:id/overrides {<key>:{value,expires_at?}|null,…}` → merge-patch the account's entitlement overrides (`credit_accounts.entitlement_overrides`) → 200 `{ok:true,overrides}` echoing the STORED map. Keys: `enterpriseEntitled`, `demoEnterprise`, `managedModelsOverride`, `maxConcurrentSessions`, `computeRateMultiplier`, `sso`, `scim`, `rbac`, `auditAccess`, `managedModels`. RFC 7386 semantics: a key with an entry sets it, a key with `null` deletes it, an absent key is untouched. Every entry may carry an ISO-8601 `expires_at`, after which the resolver ignores it — the one thing the single-purpose column routes (`ADM-13`/`ADM-16`/`ADM-17`, `session-limit`) cannot express. Rejected with 400: an unknown key, a wrong-typed `value` (boolean keys vs the two numeric ones), `maxConcurrentSessions` outside `[1,100000]` or non-integer, `computeRateMultiplier` outside `[0,10]`, a non-ISO `expires_at`, a non-object body. A PERMANENT patch to one of the four legacy-column keys also writes that column (one-release compatibility); a TIMED one clears it instead, so the expiry cannot be defeated by the column fallback. Non-admin → 403; ANON → 401.
#### Act-as impersonation

A platform admin can open a customer's account to debug it. The capability is a ROW (`kortix.impersonation_grants`), never a token: the client holds only `grant_id`, and ownership, expiry (server-written, capped at **1 hour**), revocation and the caller's CURRENT platform role are re-read on EVERY request presenting it. So revocation takes effect on the next request, and demoting an operator kills their live sessions. The impersonated account then flows through the SAME membership resolution an ordinary request uses (`resolveAccountId`, `getAccountMembership`, the IAM engine), so every account access check sees the target without a per-check admin branch.

`IMP-1` `POST /v1/admin/api/impersonate {account_id,reason?}` → mint a grant → 200 `{grant_id,account_id,account_name,expires_at}`; audited `admin.impersonate.start` against the TARGET account with the real admin as actor. Non-uuid `account_id` → 400; unknown account → 404; non-admin → 403; ANON → 401.
`DELETE /v1/admin/api/impersonate/:grantId` → revoke → 200 `{ok:true,grant_id,revoked_at}`; audited `admin.impersonate.stop`. Scoped to the caller's OWN grants — another admin's id answers 404, exactly like a nonexistent one. `GET /v1/admin/api/impersonate/active` → `{grants:[{grant_id,account_id,account_name,expires_at}]}`, the caller's unrevoked, unexpired grants.
Presenting `X-Kortix-Impersonate: <grant_id>` on any other route makes it act on the target account: `GET /v1/accounts` returns exactly that one account at role `owner`, and writes land on it. Every NON-GET impersonated request additionally writes `admin.impersonate.action` `{method,path,grant_id,impersonator_user_id,target_account_id}` against the target account BEFORE the handler runs. Denied with **403 `{code:"impersonation_invalid"}`**, never a silent fall-back to the operator's own account: an unknown/expired/revoked grant, a grant belonging to another user, a caller who is no longer a platform admin, a non-JWT credential (PAT/API key/service account), any `/v1/admin/*` route (no nested admin, no second grant, no platform-role change), any NON-GET request to a route that would create DURABLE access outliving the grant — credentials (`/v1/accounts/tokens`, SCIM tokens, service accounts, project CLI/git tokens, gateway keys), account membership and invites (`/v1/accounts/:id/members`, `/v1/accounts/:id/invites/*`), SSO provider config (`/v1/accounts/:id/iam/sso/*`), session public shares (whose `expires_at` is optional and whose consuming route is unauthenticated), and tunnel connections. READING those same surfaces stays allowed — a GET creates nothing, and the member list is the first thing a support question needs; only `/v1/admin/*` is refused for reads too — and an explicit `account_id` naming any account other than the target. Impersonation also CONFINES: while a grant is live the operator's OWN account and every third account are inaccessible, so a stale client cannot make a write land anywhere but the account the banner names.

`ADM-19` `POST /v1/billing/cron/trial-expiry` — **internal-cron auth**, not `requireAdmin` (same `requireInternalCronAuth` gate as `BILL-13`/`BILL-16`: Bearer or `X-Kortix-Internal-Key` must timing-safe-equal `INTERNAL_SERVICE_KEY`) → flips `active` trials past `trial_ends_at` to `expired` → 200 `{expired:n}`; no/wrong credentials → 401; billing internals disabled → 200 `{skipped:true}`. Status hygiene only — the lazy overlay already stopped granting at the timestamp.

#### Activity analytics

`/v1/admin/analytics/*` is a sub-router mounted INSIDE `adminApp` after its global `supabaseAuth` + `requireAdmin` gate, so it declares no auth of its own and inherits it (`apps/api/src/admin/analytics.ts`). Note the path has no `api` segment, unlike the `/v1/admin/api/*` console routes above. Both routes take `?days=` (1-90, default 30); out-of-range values are clamped and non-numeric falls back to the default — neither is a 400. Buckets are UTC calendar days and the series is dense (zero-filled), so `days[]` always has exactly the clamped length.

`ADM-21` `GET /v1/admin/analytics/activity?days=` → `{days:[{date,sessionsCreated,activeAccounts,activeUsers,newAccounts,activeProjects}],summary:{sessionsLast7d,sessionsPrev7d,dau,wau,mau,totalAccounts,totalProjects}}` → 200. `activeUsers`/`dau`/`wau`/`mau` count distinct `project_sessions.created_by`; `summary` uses fixed 1/7/30-day windows and does NOT vary with `days`. `days=0` → 1 entry; `days=9999` → 90 entries; `days=abc` → 30 entries. Non-admin → 403; ANON → 401.
`ADM-22` `GET /v1/admin/analytics/usage?days=` → `{days:[{date,computeUsd,llmUsd,otherUsd,totalUsd,payingAccounts}],summary:{totalUsd,computeUsd,llmUsd,otherUsd,spendLast7d,spendPrev7d,payingAccountsLast7d}}` → 200. Debits only, as positive USD magnitudes, classified by `metadata->>'ledger_type'` falling back to `credit_ledger.type` (the same classifier the billing usage breakdown uses), so `totalUsd` is always exactly `computeUsd + llmUsd + otherUsd`. `payingAccountsLast7d` is a window-wide `COUNT(DISTINCT account_id)`, not a sum of the daily counts. Non-admin → 403; ANON → 401.

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
`SEC-J` transport hardening — public health responses leak no secrets or framework headers; sensitive paths stay hidden; malicious origins receive no permissive CORS; adversarial bodies and content types produce no 5xx, reflection, or secret leakage; HTTP method fuzzing never bypasses auth; the router is not an anonymous upstream relay.

### Role × project-action grid (assert per row)

| Action level                                                   | OWNER | ADMIN | M_MANAGER | M_EDITOR | M_VIEWER | MEMBER (no grant) | NONMEMBER |
| -------------------------------------------------------------- | ----- | ----- | --------- | -------- | -------- | ----------------- | --------- |
| `read` (GET project/files/sessions)                            | ✓     | ✓     | ✓         | ✓        | ✓        | ✗ 403             | ✗ 403     |
| `session` (create/PATCH/DELETE/restart session — use the chat) | ✓     | ✓     | ✓         | ✓        | ✓        | ✗ 403             | ✗ 403     |
| `write` (PATCH project, CR merge, deploy, triggers)            | ✓     | ✓     | ✓         | ✓        | ✗ 403    | ✗ 403             | ✗ 403     |
| `manage` (DELETE project, secrets, members/access)             | ✓     | ✓     | ✓         | ✗ 403    | ✗ 403    | ✗ 403             | ✗ 403     |

### Role × account-action grid

| Action                                    | OWNER | ADMIN | BILLING | AUDITOR | MEMBER |
| ----------------------------------------- | ----- | ----- | ------- | ------- | ------ |
| `account.read` / member.read / audit.read | ✓     | ✓     | ✓       | ✓       | ✓      |
| `account.write` (rename)                  | ✓     | ✓     | ✗       | ✗       | ✗      |
| `member.invite/update/remove`             | ✓     | ✓     | ✗       | ✗       | ✗      |
| `member.super_admin.grant` (owner role)   | ✓     | ✗     | ✗       | ✗       | ✗      |
| `billing.write`                           | ✓     | ✗     | ✓       | ✗       | ✗      |
| `account.delete`                          | ✓     | ✗     | ✗       | ✗       | ✗      |
| `project.create`                          | ✓     | ✓     | ✗       | ✗       | ✗      |

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
- No inbound GitHub event webhook (no push/PR receiver) — see the trigger
  boundary notes at the end of section 12.
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

- **API (Bun):** the working path is **in-process** — implement curl flows as a `bun test` driver that imports the _real_ app and calls `app.fetch(new Request(...))`, not the stub `createTestApp()` in `apps/api/src/__tests__/helpers.ts` (it mounts only a handful of routes and bypasses the monolith). The real app is exported at `apps/api/src/index.ts` (`export default { fetch }`). Then:
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

## 24. Connector catalog and connections

`CONN-1` `GET /connectors/catalog` → connector-principal (sandbox KORTIX_TOKEN) route; user JWT + `ANON` → 401 (200 path exercised in-sandbox). The deprecated `GET /connectors/connectors` alias preserves the same auth contract for older clients.
`CONN-2` `GET /connectors/projects/:id/connectors` → project admin → 200; `NONMEMBER` → 403.
`CONN-3` `POST /connectors/call {connector,action,args}` → connector-principal route; user JWT + `ANON` → 401.
`CONN-4` `POST /connectors/projects/:id/connectors/sync` → admin → 200 (re-materialize from kortix.yaml).
`CONN-5` `GET /connectors/projects/:id/policies` → admin → 200; `PUT …/policies {policies[]}` → admin → 200.
`CONN-7` `PUT /connectors/projects/:id/connectors/:slug/credential` → accepts a static value or native OAuth2 client-credentials configuration; missing value or a non-HTTPS OAuth2 token URL → 400.
`CONN-8` `POST /connectors/projects/:id/connectors` → admin; invalid JSON or non-boolean `create_only` → 400. A first `create_only:true` request creates the connector; a second request for the same slug → 409 and does not replace the existing manifest entry. Because the manifest write is a Git commit round-trip and the test client retries a lost POST, the FIRST create is asserted as `200`-or-`409` — the 409 IS this contract answering a re-delivery — and the config read proves the entry landed exactly once. `DELETE …/:slug` → admin → ok/404.
`CONN-9` `GET /connectors/projects/:id/pipedream/apps` and `/pipedream/sections` → admin → 200 or 501 (pipedream not configured); sections returns stable bounded category slices and rejects non-members.
`CONN-13` `PUT /connectors/projects/:id/connectors/:slug/credential-mode|authorization-strategy|name|policies` → admin (`project.connector.write`); body validated before the connector lookup (bad mode, unsupported authorization strategy, empty name, or invalid policy action → 400 even against an unknown slug); well-formed body + unknown connector → 404; NONMEMBER → 403.
`CONN-14` `POST /connectors/projects/:id/connectors/auth-discovery {provider,spec|url|endpoint|baseUrl}` → admin (`project.connector.write`) loads the guarded direct source and returns normalized authentication candidates plus a supported recommendation; omitted auth on `POST …/connectors` applies that recommendation, while explicit `{auth:{type:"none"}}` skips discovery and remains a durable opt-out. Source credential literals are never returned.
`CONN-15` Project admin enables `connectors_api_discover` through `PATCH /projects/:id/features`; `GET /connectors/projects/:id/discover/connectors[?q&cursor]` → browses the direct integrations.sh catalogue; `GET …/discover/connectors/detail?id=…` → resolves the trusted record's API/MCP/Postman/GraphQL/docs/CLI variants; upstream outage → 502; `NONMEMBER` → 403 before any upstream fetch.
`CONN-19` `PUT /connectors/projects/:id/connectors/:slug/secret-binding {secret_identifier}` → project admin binds an active `broker`/`connector` project secret or clears the binding with `null`; malformed identifiers → 400; unknown connector → 404; stored credentials, user-owned authorization, platform authentication, and incompatible secrets → 409; `NONMEMBER` → 403.
`CONN-OAUTH2` connection-scoped native OAuth2 routes → save and read a redacted provider-independent application; start Authorization Code with PKCE S256; read status; reject SSRF discovery, unavailable Device Authorization, unknown device sessions, and callback state replay. Connection creation follows the connector's authorization strategy: the default `project` strategy accepts only `owner_type: "project"`; any other owner_type → 409 `CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH`, and `/me` member connections require the `user` strategy.

**Connector access has three gates.** The agent's `connectors` grant selects
connector slugs. The connector's `authorization_strategy` selects `project` or
the acting member's `user` connections. Connector policies apply to every
connection under that connector. `connectors_required` is a subset of
`connectors`; missing active strategy-compatible connections return `409
CONNECTOR_CONNECTION_REQUIRED` before sandbox startup. Session
creation returns `409 REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE` when a required
slug has no configured connector. Session
`connector_bindings` use connector slugs and `connection_id`
values. `GET /projects/:id/sessions/:sessionId/scope` reads the effective
secret allowlist and connection map. `PUT` on the same path replaces each
supplied scope field without restarting the session.

---

## 25. Parallel-authored domains (git/platform/iam/channels/queue/audit/scim)

`GH-9` `GET /git/:project/info/refs` · `POST …/git-upload-pack` · `POST …/git-receive-pack` → smart-HTTP proxy, git token auth (not JWT); bad/no token → 401/502.
`GH-10` `GET /git/:project/info/refs` → user JWT is not a git token → 401/403; NONMEMBER → 401/403/404.
`GH-11` `GET /projects/:id/git/clone-credential` → runtime tokens only; ANON → 401, user JWT/account-PAT → 403.
`GH-12` `POST /projects/:id/git/collaborators` → missing username → 400; non-managed → 409; no install → 502.
`GH-13` `GET /projects/github/repositories` → PROJECT_CREATE; no App install → 409 install_url.
`GH-14` `POST /projects/create-repo` → PROJECT_CREATE; missing name → 400; no install → 409/503.
`GH-15` `POST /projects/link-repository` → PROJECT_CREATE; missing repo → 400; no install → 400/409/502; bad token → 400.
`GH-16` `GET /projects/github/repository-branches` → PROJECT_CREATE; returns the repository default plus every existing branch; missing installation → 409; wrong installation owner → 400.
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
`AUD-1` `GET /accounts/:id/audit` → 200 `{events,next_cursor}`. Each event exposes the centralized envelope: project/session/OpenCode/turn/message/tool/execution identifiers, monotonic `session_sequence`, actor/agent/initiator/delegation identity, authoritative and client-reported sources, action/phase/outcome, request/trace/correlation/causation identifiers, source-ledger identity, redacted summaries and SHA-256 digests, and integrity-chain fields. The route filters by project, session, actor, actor type, source, phase, outcome, request, correlation, resource, action, time, or free-text search. Authentication determines `authoritative_source`; validated `X-Kortix-Client` values populate only `client_reported_source`. A correlated project request can be reconstructed through one exact filtered query. NONMEMBER → 403.
`AUD-2` `GET /accounts/:id/audit/export` → 200 (CSV/JSONL); bad format → 400; NONMEMBER → 403.
`AUD-3` `GET /accounts/:id/audit/webhooks` → 200; NONMEMBER → 403.
`AUD-4` `POST`/`PATCH`/`DELETE /accounts/:id/audit/webhooks[/:id]` → 201 secret-once; bad url → 400; unknown → 404; delete 200.
`AUD-5` Audit edge cases: ANON → 401 on every audit route; MEMBER (in-team, no audit.read/account.write) → 403; malformed/zero/negative/oversized limits, malformed timestamps, malformed UUID filters, and malformed cursors → 400; cursor pagination has no overlap, including PostgreSQL microsecond timestamps serialized through JavaScript milliseconds; export responses expose resumable row-count/complete/next-cursor headers; webhook create validation (missing name, >128 name, malformed URL, SSRF 169.254.169.254 → 400); webhook secret-once invariant (no leak on GET list / PATCH); cross-account isolation (teamA hook via teamB path → 404).
`AUD-6` Canonical v2 operations: `GET /projects/:id/audit` → the project-bound canonical page; `POST /accounts/:id/audit/reconcile` → bounded idempotent reconciliation result; `GET /accounts/:id/audit/webhooks/:webhookId/deliveries` → durable delivery rows; `POST .../deliveries/:deliveryId/replay` → `{replayed:true}`; human auth on `POST /projects/:id/sessions/:sid/audit/events` → 403 because ingestion requires the session-bound sandbox token.
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
`PROJ-16` `POST /projects/:id/turn-question {session_id,questions[]}` → missing session id → 400; unknown session id → 404 before questions validation.
`PROJ-17` `POST /projects/:id/turn-stream {session_id,text}` → missing session id → 400; unknown session id → 404 before event-payload validation; `kind:end|turn_end` needs only a valid `session_id` (`status: idle|error`) → 200 `ok:false` when no live stream.
`PROJ-18` Project cap by plan: a FREE account may own exactly 1 project — `POST /projects/provision` for the 2nd → 403 `{code:project_limit_reached,limit:1}` (checked before any repo is provisioned); paid/team plans get `MAX_PROJECTS_PER_ACCOUNT`. Archived projects do not consume the slot, so deleting the one project frees it. Requires `managedGit`+`stripe` (billing enforced).
`PROJ-19` Full v2 agent-config editor (agent-first spec §2.2): `GET /projects/:id/agents/:agentName/config` (`read`) → 200 `{agent,schema_version,editable,default_agent,block}` — `editable:false` + `block:null` for a v1/empty manifest (the UI's degrade signal), the agent's full `AgentBlockV2` for a declared v2 agent; `PUT /projects/:id/agents/:agentName/config {…AgentBlockV2}` (`manage`, gated `project.customize.write`) validates the block through the manifest-schema validator (bad permission tree/enum/ungrantable `kortix_cli` → 400 `invalid_config`) then writes it into the `agents:` map in `kortix.yaml`; a v1 project is refused with a 400 upgrade pointer (v2-only); malformed body → 400 `invalid_body`; caller with no project grant → 403.
`MKTP-1` `GET /marketplace/items {query?,type?}` → auth → 200 `{items:[{id,registry,name,type,title,description,categories,capabilities,dependencies,fileCount,managedBy?,updatePolicy?}]}` (catalog includes the minimal Kortix runtime skills, optional General Knowledge Worker skills such as `pdf`, and curated bundles; the default starter does not ship the GKW pack; `?query=`/`?type=` filter).
`MKTP-2` `GET /marketplace/items/:id` → auth → 200 item detail (`files`, `readme`, `capabilities`, managed metadata when applicable); unknown id → 404.
`EXP-1` `PATCH /projects/:id/features {feature,enabled}` (canonical) and `PATCH /projects/:id/experimental` (deprecated alias, same handler) → 200 with `experimental`/`experimental_features` in body; unknown flag → 400; non-bool enabled → 400; `enabled:null` clears the override → 200; archived project → 404 with metadata unchanged. Flag-gated routes reject with `403 {code:'feature_disabled', feature}` when their flag is off.
`SNAP-3` `POST /projects/:id/snapshots/fix-with-agent` → no failed build → 409; else 201.
`SBX-3` `GET /projects/:id/sandboxes` · `/sandbox-health` · `/sandbox-templates` → 200.
`SBX-4` `POST /sandbox-templates` → 201; bad → 400; reserved/dup → 409; `PATCH/DELETE/build /:templateId`; unknown → 404.
`PACC-5` `POST /projects/:id/access/invite` → 201 pending; `GET/POST resend/DELETE pending-invites[/:id]` → manage; missing email → 400; unknown → 404.
`PACC-6` `GET/POST /projects/:id/group-grants` · `PATCH/DELETE /:groupId` → manage; missing group_id → 400; unknown → 404.
`BILL-10` per-seat: `POST /billing/sync-seat-quantity` · `claim-per-seat` → no-op/skipped on non-legacy.
`AUTH-1` `POST /v1/auth/logout` → OWNER 200/204; ANON 200/401.
`AUTH-2` `POST /v1/webhooks/auth/send-email` — Supabase Auth send-email hook, public + Standard Webhooks HMAC (`AUTH_EMAIL_HOOK_SECRET`, `v1,whsec_…`) over the RAW body. Unsigned → 401 (503 when no secret is configured); valid signature over a tampered body → 401; signed `magiclink` payload → 200 and the mail goes out through the one platform transport (`EMAIL_URL`); unknown `email_action_type` → 400.
`BILL-11` `GET /billing/checkout-session/:sessionId` · `POST /billing/confirm-checkout-session` → unknown/missing → 4xx.
`BILL-3b` `POST /billing/create-checkout-session` · `create-per-seat-checkout` · `create-portal-session` → Stripe URL or 400/500.
`BILL-4b` `POST /billing/cancel-subscription` · `sync-seat-quantity` → NONMEMBER → 403.
`DEL-2b` `/billing/account/*` deletion mirror — request → cancel lifecycle.
`SESS-11` session sub-routes (commit-push/ensure-opencode/restart/wake) → unknown/non-uuid session → 4xx (happy paths need a funded session, run on dev-api).
`SEC-5` `PUT/DELETE /projects/:id/secrets/:name/personal` → per-user secret override set/clear.
`CONN-10` `POST /connectors/projects/:id/connectors/:slug/connect[/finalize]` → pipedream; unknown connector → 404/501.
`CONN-11` `POST /connectors/webhook/pipedream` → public, HMAC-signed. Reads the external user id from `account.external_id` (the real Pipedream CONNECTION_SUCCESS shape) or top-level `external_user_id` (legacy); `event:"CONNECTION_ERROR"` → 200 `{ok,ignored}`; neither id present → 400; bad signature → 401; signed but Pipedream still reports no account → 503. AUXILIARY only — it never notifies a session.
`CONN-22` public connector setup-link consume side: `GET /setup-links/connectors/:token` (what app does this link connect) · `POST /setup-links/connectors/:token/start` (mint a fresh Pipedream connect URL) · `POST /setup-links/connectors/:token/finalize` (the authoritative persist: 200 `{connected:true|false}`, notifies the requesting session exactly once on the first true). Bogus token → 404 on all three; wrong link kind → 400; expired → 410; non-project authorization strategy → 409.
`CONN-12` `GET /connectors/projects/:id/connectors/:slug/config` → admin reads a connector's connection def for editing; unknown connector → 404/501; NONMEMBER → 403.
`DEL-3` `DELETE /v1/account/delete-immediately` (+ /billing mirror) → ANON → 401 (auth boundary; destructive happy path not run).

---

## 27. Kortix as a Backend (KaaB) — session-create override contract

Origin is derived from the caller's token kind, never the request body. An
account PAT, service account, or user API key resolves to `origin: backend`. A
human web JWT resolves to `origin: user`. In-sandbox and agent-scoped tokens are
never backend. Only a backend caller may set the `secrets` override. Customer
metadata stays in the wrapper's data store. See
`docs/KORTIX_AS_A_BACKEND_GUIDE.md`.

`KAAB-1` backend PAT `POST /projects/:id/sessions {runtime_context}` → 201; response contains derived `origin:"backend"` and `session_id`.
`KAAB-2` non-backend user JWT setting `secrets` → **403 `origin_override_forbidden`** before secret validation.
`KAAB-3` backend `secrets=[unknown]` → **404 `SECRET_IDENTIFIER_NOT_FOUND`**; `secrets=[]` → 201 with `secrets_allowlist:[]` (inject zero project secrets). Narrowing only — never widens beyond the agent's grant.
`KAAB-4` backend `opencode_model` that isn't servable (retired / not entitled / typo) → **400 `INVALID_SESSION_MODEL`** at create, not a dead turn at prompt time; a bare managed id is normalized to the `kortix/<id>` opencode ref.
`KAAB-5` backend `runtime_context` with a credential-like key → 400; over the 64-entry / 16 KiB caps → 400 (`INVALID_SESSION_RUNTIME_CONTEXT`).
`KAAB-6` backend `Idempotency-Key` retry: same key + same body → the SAME `session_id` (no double-create / double-charge); same key + a different `secrets`/`connector_bindings` body → **409** (`IDEMPOTENCY_SECRETS_CONFLICT` / `IDEMPOTENCY_BINDING_CONFLICT`).
`KAAB-7` backend idempotency context guard. The key-claiming create is `201` (row created) or `202` (the claim is still in flight — the answer to a re-delivered POST); both name the same `session_id`. Then: same key + different `runtime_context` → **409 `IDEMPOTENCY_CONTEXT_CONFLICT`**; a replay whose stored session was soft-deleted → 409 `IDEMPOTENCY_KEY_SESSION_DELETED`; an oversized `Idempotency-Key` header (>255 chars) → **400 `INVALID_IDEMPOTENCY_KEY`**.

---

## 28. Kortix Apps

Kortix Apps are project-owned serverless deployments. The API owns the stable
hostname, immutable artifact and deployment records, provider-neutral machine
specification, runtime lifecycle, billing attribution, and atomic active
deployment pointer. The provider remains an implementation detail.

`APP-1` App CRUD — `GET/POST /projects/:projectId/apps` and
`GET/PATCH/DELETE /projects/:projectId/apps/:appId`. Apps is a per-project
feature flag, off by default: a member of a flag-off project gets
`403 {code:'feature_disabled', feature:'apps'}` on every apps route; the flow
first clears any override left by a reused local fixture, then enables the flag
via `PATCH /projects/:projectId/features` and proceeds. A
project writer creates a unique lower-case slug and machine policy; list/get
return the stable public URL and active deployment pointer; patch updates
mutable policy; delete is soft and removes the App from subsequent reads.
Invalid slugs → 400; `NONMEMBER` → 403.

`APP-2` Artifact and deployment boundaries —
`POST /projects/:projectId/apps/artifacts` registers an immutable archive upload
or OCI reference; `POST …/artifacts/:artifactId/finalize` finalizes only an
awaiting archive. The flow enables the `apps` feature flag first (off by
default). Access policy — `GET/PATCH …/:appId/access` read and persist the
mode; `restricted` without any member or group → 400; `project` persists and
reads back; `POST …/:appId/access-session` returns a signed URL + expiry for a
member. `POST …/:appId/deployments` requires a ready artifact and an
exact source-kind match. Deployment list/detail/logs expose durable state.
Unknown deployment detail and logs return 404.
Rollback accepts only a ready deployment. Start and stop require an active
deployment. Finalizing an OCI artifact, using a mismatched OCI image, rolling
back an unknown deployment, or starting/stopping an undeployed App → 409/400 as
specified by each route. `APP-2` exercises these boundaries through the real
HTTP API, then deletes the test App.

`APP-3` Machine limits — an App machine answers to the same ceiling a session
sandbox does (`SANDBOX_SPEC_LIMITS`: 32 CPU, 128 GB memory, 500 GB disk). The
create route refuses `cpu: 64`, `memory_gb: 512`, and `disk_gb: 2048`
independently with **400**, accepts exactly 32/128/500, and applies the same
bounds to `PATCH …/:appId` so resizing an existing App cannot escape them. A
value below the floor (`cpu: 0`) is refused too. Apps reject rather than clamp:
an App bills from the specification it recorded, so a silent downgrade would
charge for compute the provider never allocated.

`APP-4` Team scoping — an App's access policy governs who on the TEAM sees it,
not only who reaches its hostname, using the model sessions use. A new App is
`private`: a project member who did not create it does not receive it in
`GET …/apps`, and gets **404** from `GET …/:appId` (never 403 — the status must
not disclose that a teammate's private App exists); their `PATCH …/:appId` is
**403** because a member holds no `project.app.write` at all, which discloses
nothing either. Switching the
policy to `project` puts the App in that teammate's list and makes it readable;
`restricted` with their `member_ids` keeps them in; returning to `private` puts
them back out. `password` is a PUBLIC-traffic control and stays team-visible.
A `NONMEMBER` remains 403 on the whole surface.

`APP-5` Edge TLS gate — `GET /v1/apps/edge/tls-check?domain=<host>` is the
unauthenticated `ask` a self-host reverse proxy calls before it issues an
on-demand certificate for an App hostname. It answers **200** only for a real
App public host (the hostname the create route just handed out), **403** for a
hostname that is not an App host and for a call with no `domain` at all, and
**404** for an App-shaped hostname whose immutable route key belongs to no App.
A local `*.apps.localhost` deployment never issues certificates and answers 200
without the database round-trip; the 404 branch is pinned source-level in
`apps/api/src/apps/edge.test.ts`. The route discloses only whether a hostname is
servable — the same fact the hostname's own DNS record already states.

---

## 29. Additional executable product contracts

These contracts use product IDs. They replace the old route-coverage bucket IDs.

`ADM-2b` An admin lists the projects for one account. Anonymous and non-admin callers are rejected.
`ADM-7` An admin reads provider analytics. Anonymous and non-admin callers are rejected.
`ADM-8` An admin reads and updates provider distribution. Invalid input and non-admin callers are rejected.
`ADM-9` An admin reads and updates provider fallback configuration. Invalid input and non-admin callers are rejected.
`ADM-10` An admin lists current sandboxes. Anonymous and non-admin callers are rejected.
`ADM-11` An admin requests migration for one session sandbox. An unknown session and non-admin callers are rejected.
`ADM-12` An admin changes an account tier. Unknown tiers and non-admin callers are rejected.
`ADM-13` An admin changes the Enterprise entitlement. Non-boolean input and non-admin callers are rejected.
`AUD-FILTER` One correlated project request is reconstructed through the account audit filters without returning unrelated events.
`BILL-9b` Anonymous and non-member callers cannot cancel, reactivate, or schedule a subscription change.
`BILL-12` A fresh personal account reads as the funded free tier with active billing state and lifetime rollups.
`BILL-14` An owner reads credit breakdown, credit usage, tiers, transaction summary, and usage history. Anonymous callers are rejected.
`CHN-21` A Slack identity login token resolves or returns the documented invalid-token boundary.
`CHN-22` The public Slack manifest route returns the project manifest or the documented project/configuration boundary.
`CHN-23` A project writer binds a Slack thread. Invalid input and unauthorized callers are rejected.
`CHN-24` The project Slack command webhook verifies its request before it starts work.
`CHN-25` The project Slack interactivity webhook verifies its request before it starts work.
`CHN-26` A Slack file download without a file reference returns the documented validation or installation error.
`CHN-27` An anonymous caller cannot update a project email installation.
`CHN-28` An anonymous caller cannot bind a Slack identity.
`CHN-T1` A project member reads the Microsoft Teams installation state.
`CHN-T2` A project member reads the Microsoft Teams channel mode.
`CHN-T3` A project manager starts Microsoft Teams connection. Invalid input and unauthorized callers are rejected.
`CHN-T4` The Microsoft Teams messages webhook verifies its request before it starts work.
`CONN-16` A project manager deletes a connector credential. Unknown connectors and unauthorized callers are rejected.
`CONN-17` A project member reads connector policies. Unknown connectors and non-members are rejected.
`CONN-18` A project manager creates a connector setup request. Missing or unconnected connector slugs are rejected.
`CONN-20` Authentication protects connection status, connector catalog, and connector call routes. Invalid calls do not reach an upstream service.
`CONN-21` A project creates, lists, activates, authenticates, credentials, and revokes project and member connections through their complete lifecycle.
`CONN-23` Connection roster and default-connection mutations hide an unknown project with 404.
`DEL-4` Immediate account deletion removes the owned account state and the deletion-status read confirms the result.
`GHA-1` A platform admin configures, reads, and removes the GitHub App or PAT integration through the supported setup routes.
`GHA-2` GitHub App manifest and installation callbacks reject invalid state and preserve the configured integration.
`GHA-3` The GitHub App OAuth identity-proof callbacks reject an untrusted frontend origin and a forged state without minting a token.
`GW-1b` The public LLM gateway health alias returns its health contract.
`GW-2c` The OpenAI-compatible LLM models alias enforces authentication and returns the supported model envelope.
`GW-3b` The OpenAI-compatible LLM chat alias enforces authentication before model execution.
`GW-7` Anthropic-compatible message aliases enforce authentication and preserve the shared routing contract.
`GW-8` Internal route resolution rejects missing internal credentials and validates a signed request.
`GW-9` Project gateway analytics, logs, budgets, keys, playground, and provider verification enforce project permissions and payload validation.
`GW-10` Every internal gateway control route rejects a request without internal credentials.
`GW-12` Internal gateway authorization rejects a request without internal credentials.
`GW-13` `GET /v1/usage` exhausts the `group_by` enum and its per-value response shape: `provider` rows carry `provider` only, `day` rows carry `day` only, `model` rows carry both `provider` and `model` — never a field from another grouping. A malformed `start` or `end` timestamp is a 400 boundary distinct from an inverted window, and a window containing no `usage_events` returns 200 with zeroed totals and an empty `breakdown`, never 404 or 500.
`INV-6` A pending account invite admits the invited user and applies the project bootstrap grant.
`INV-7` Invite accept and decline are email-bound, idempotent where documented, and cannot be used by another user.
`MEM-6` Changing an account role reconciles project grants so account-wide permissions do not retain stale project rows.
`MEM-7` `POST /accounts/:id/members {email,role,project_grants}` grants project access alongside the invite: applied immediately for an existing user, staged on the pending invite and applied on accept for a new one. A grant naming a project outside the caller's account is rejected. Grants are ignored for `admin`/`owner` invites (implicit access already covers every project).
`MKTP-6` An authenticated user reads one catalog file. Unknown items and invalid paths are rejected.
`MKTP-7` An authenticated user lists available marketplaces.
`MKTP-8` An authenticated user reads the featured marketplace collection.
`MKTP-9` An authenticated user lists configured marketplace sources.
`MKTP-10` An authorized user adds and removes one marketplace source. Invalid and protected sources are rejected.
`MKTP-11` A project writer starts an agent-driven marketplace installation session. Missing items, unknown items, and unauthorized callers are rejected.
`PROJ-20` An authenticated user reads whether managed Git is configured.
`PROJ-27` A project member reads model choices and a project manager sets, reads, and clears model defaults.
`PROJ-28` The Suna migration eligibility, status, and start routes enforce authentication and current migration state.
`PROJ-30` A project manager changes the default agent. Invalid agents and unauthorized callers are rejected.
`PROJ-31` A project manager changes the sandbox provider. Invalid transitions and unauthorized callers are rejected.
`PROJ-32` A project member reads the provider catalog. Unknown projects and non-members are rejected.
`PROJ-33` A project member reads the current sandbox-provider transition state.
`PROJ-35` A project manager changes model enablement and reads back the persisted result.
`SBX-5` A project member reads the project sandbox inventory. Non-members are rejected.
`SBX-6` Daytona and Platinum webhooks reject unsigned provider payloads.
`SCIM-5` SCIM resource-type, schema, and user-replacement routes preserve tenant and bearer-token boundaries.
`SEC-7` A project manager creates a secret setup request. The public link validates its token and writes the submitted value once.
`SESS-17` A project member reads session previews. Unknown sessions and non-members are rejected.
`SESS-18` Warming a project creates one ordinary session marked unused, and returns that same session until it is used. The unused session is hidden from the `visible` session list and present in the manager's `project` inventory. First use drops the marker and the session lists normally; a second use returns `409 WARM_SESSION_ALREADY_CLAIMED`. The next warm creates a replacement. Adoption via `POST /start` (the path the browser actually takes) drops the marker in the same statement it stamps `last_activity_at` and `updated_at`, so the adopted session lists immediately and sorts as the newest for both the web client's activity sort and the API's `updated_at` order. A warm ensure after adoption never returns the adopted session — handing a used session back is how a project-home send lands its prompt inside an existing conversation. A warm ensure carrying `exclude_session_id` creates a fresh session even while the excluded session's marker is still set.
`SESS-19` Session configuration freshness, reload, and streamed reload routes reject anonymous callers and hide unknown projects.
`SESS-20` The session transcript route returns 404 for an unknown session.
`SYS-8` Live and ready health aliases return the same service-state contract.
`SYS-9` Metrics requires internal authorization and router health returns its configured availability state.
`TOK-5` Revoking a project CLI token immediately blocks its project, secret, and trigger mutations.

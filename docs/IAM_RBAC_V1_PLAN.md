# IAM/RBAC v1 — Project-Scoped Roles, Policies & Resource Permissions

> Status: **IN PROGRESS** on branch `feat/iam-rbac-v1`. Phase 0 + 1a done; Phase 1b partial. See §10.
> Owner: Ino. Author: planning pass (survey of the live authz code, 2026-06-23).
> Companion reading: `apps/api/src/iam/*`, `apps/web/src/lib/iam-client.ts`, `packages/db/MIGRATIONS.md`.

---

## 0. TL;DR

**The ask:** Inside a single project, scope resources & config to roles/users/groups, and let a role have capabilities **deactivated** (Git Ops, Schedules, Webhooks, Customize sections…). Driving use case: **one big company project** with **departments scoped inside it** (e.g. 10 Marketing members who can act in their slice without seeing/touching the rest) — instead of one repo per department.

**The reality (verified):** The IAM engine is already Cloudflare-shaped and ~70% there — but it has **two structural gaps** that make intra-project scoping impossible today:

1. **Everything below the project collapses to `project.read` / `project.write`.** `loadProjectForUser(c, id, 'read'|'write'|'manage')` is the gate for Agents, Skills, Commands, Schedules, Webhooks, Files, Customize, Git Ops — and `manage` even maps to `project.write` ([access.ts:238](apps/api/src/projects/lib/access.ts)). There are **no per-capability action strings**, so there is nothing to toggle.
2. **Roles are 6 frozen `Set`s in code**, not data ([role-perms.ts:57,102](apps/api/src/iam/role-perms.ts)). The `role.*` / `policy.*` actions ([actions.ts:45-52](apps/api/src/iam/actions.ts)), the `VALID_ACTIONS` custom-role validator ([actions.ts:133](apps/api/src/iam/actions.ts)), and `ACTION_CATALOG` ([actions.ts:157](apps/api/src/iam/actions.ts)) are **reserved with zero engine consumers**. No custom/department roles exist.

**The unlock (verified, and the reason this is "activate + extend", not greenfield):** the frontend **already ships a complete IAM management SDK** — [`apps/web/src/lib/iam-client.ts`](apps/web/src/lib/iam-client.ts) defines `IamRole`, `IamPolicy`, `PrincipalType`, `PolicyScopeType`, `ActionCatalogEntry`, and calls `GET/POST /accounts/:id/iam/roles`, `PUT /iam/roles/:id/permissions`, `GET /iam/actions`, full `/iam/policies` CRUD + `:bulk-import` + `:simulate` + `roles/:id/usage`. **Those backend routes 404 today.** The contract is pre-designed; we build the backend to match it and wire the engine to read it.

**Strategy:** stay **allow-only, highest-wins** for v1 (no explicit deny — reserved for v2). Built-in roles become **seed rows** so the engine has one code path. Every phase ships independently and is **backward-compatible (no lockout)**.

---

## 1. Verified current state (with file:line)

### 1.1 The engine — `authorizeV2` ([engine-v2.ts:274](apps/api/src/iam/engine-v2.ts))
- Single role, **allow-only, highest-wins**. No deny, no conditions. V1 policy engine retired (`engine.ts` is type-only).
- `scopeForActionV2` ([engine-v2.ts:53](apps/api/src/iam/engine-v2.ts)) = **prefix switch**: `account.*/billing.*/audit.*/member.*/group.*/role.*/policy.*/token.*` → `account`; **everything else → `project`**. (Good: new `project.agent.*` etc. fall through to `project` automatically.)
- Decision = `PROJECT_ROLE_PERMS[effectiveRole].has(action)` (project) / `ACCOUNT_ROLE_PERMS[role].has(action)` (account) ([role-perms.ts:132-139](apps/api/src/iam/role-perms.ts)).
- **Role merge** `deriveEffectiveProjectRole` ([engine-v2.ts:78](apps/api/src/iam/engine-v2.ts)): fold the implicit account role (owner/admin → `manager`), the direct `project_members` row, and every `project_group_grants` row via `maxProjectRole` (viewer<editor<manager). **No source can subtract.**
- **Owner / admin / super_admin bypass ALL project gates** ([engine-v2.ts:304](apps/api/src/iam/engine-v2.ts), `loadEffectiveProjectRole:224`). → Department isolation cannot contain an account owner/admin (see Open Q1).
- Public API (`iam/index.ts` → [dispatcher.ts](apps/api/src/iam/dispatcher.ts)): `authorize()`, `assertAuthorized()` (403 on deny), `listAccessibleResources()`. The dominant project gate is `loadProjectForUser` ([access.ts:265](apps/api/src/projects/lib/access.ts)).

### 1.2 The collapse point ([access.ts:238](apps/api/src/projects/lib/access.ts)) — verified verbatim
```
read   → project.read
write  → project.write
manage → project.write   // "editors aren't accidentally locked out"; stricter routes add an explicit assertAuthorized on top
```
So **every feature route bottoms out at `project.read` or `project.write`** (r3/r4/r5/r8/r9/r10). The Members surface ([r6.ts](apps/api/src/projects/routes/r6.ts)) is the **proven pattern** for stricter gating: `loadProjectForUser('write')` + an explicit `assertAuthorized(...members.manage)`.

### 1.3 Roles & actions
- 6 roles as **additive slices** ([role-perms.ts](apps/api/src/iam/role-perms.ts)): account `MEMBER_BASELINE` + `ADMIN_EXTRAS` + `OWNER_ONLY`; project `VIEWER_BASELINE` + `EDITOR_EXTRAS` + `MANAGER_ONLY`. (Additive shape = trivial to seed into `iam_role_actions`.)
- Reserved & dark: `ROLE_*` / `POLICY_*` actions, `VALID_ACTIONS`, `ACTION_CATALOG` — present, consumed by nothing except a negative validator at `agents.ts:305`.
- **Confirmed absent in schema** (`packages/db/src/schema/kortix.ts`): `iam_roles`, `iam_policies`, **and the `iam_resource_type` pg enum** (prior memory was wrong — `RESOURCE_TYPES` is TS-only; `resource_type` columns are plain `text`).

### 1.4 The pre-built frontend contract ([iam-client.ts](apps/web/src/lib/iam-client.ts))
`IamRole` (:40), `IamPolicy` (:67, fields `principal_type / principal_id / scope_type / scope_id`), `ActionCatalogEntry` (:364), `createRole / updateRolePermissions / listActions / createPolicy / bulk-import / simulate / role usage`. **No `.tsx` consumes it yet** — UI components are also to-build, but the **types + endpoint contract are fixed**, which pins our table shapes and route signatures.

### 1.5 The cache bug ([engine-v2.ts:151/169/239](apps/api/src/iam/engine-v2.ts), [access.ts:101](apps/api/src/projects/lib/access.ts))
Four uncoordinated `ttlMemo` instances, TTL ~15s, **positive-only caching**, and **nothing ever calls `.clear()`** → a revoke/demote/group-removal lags up to 15s across replicas. Until fixed, **no gate is a real security boundary**. `ttl-memo.ts` already has `.clear()` (:85) but no keyed invalidation.

### 1.6 The bypass seams (where "deactivate" becomes cosmetic if missed)
- **Git proxy**: `authorizeGitProxy` ([git.ts:579](apps/api/src/projects/git.ts)) takes `_scope` (**unused**), authorizes read==write on account-ownership; comment defers role gating to "M2". **This is M2.**
- **Automation**: `fireGitTrigger` ([triggers.ts:606](apps/api/src/projects/triggers.ts)) resolves the owner actor then calls `createSession`/`continueSession` with **no `assertAuthorized`** → a trigger owned by a now-restricted user still runs full-power.
- **Service accounts**: `middleware/auth.ts:120` sets `userId = service_account_id`, but `resolveActorV2Uncached` ([engine-v2.ts:120](apps/api/src/iam/engine-v2.ts)) queries `account_members` by userId only → SAs resolve `not_a_member`. Bridged via `iam_policies(principal_type='token')`.

---

## 2. Target data model (additive; mirrors the pre-built `iam-client` contract)

All account-scoped, nullable-safe, copying existing patterns (`project_secret_grants`, `project_group_grants`). Edit `packages/db/src/schema/kortix.ts` → `pnpm migrate:generate <slug>` → review SQL → commit **both** `.sql` and the drizzle snapshot (per [MIGRATIONS.md](packages/db/MIGRATIONS.md)). **Use the `migration` skill.**

| Table | Purpose | Key columns |
|---|---|---|
| `iam_roles` | DB-driven roles (custom + the 6 built-ins as `is_builtin` seeds) | `role_id`, `account_id`, `key`, `name`, `description`, `scope_type('account'\|'project')`, `is_builtin`, `built_in_key`, `created_by`, ts; `unique(account_id,key)` |
| `iam_role_actions` | role → leaf action set (the capability list) | `role_id`, `action varchar(96)` (validated vs `VALID_ACTIONS`); PK(`role_id`,`action`) |
| `iam_policies` | bind principal → role @ scope (the assignment) | `policy_id`, `account_id`, `principal_type('member'\|'group'\|'token')`, `principal_id`, `role_id`, `scope_type('account'\|'project')`, `scope_id`(nullable→account-wide), `expires_at`(nullable), `granted_by`, ts |
| `iam_resource_grants` *(Phase 4)* | per-resource sub-project scoping; generalizes the secret/session/connector grant triad | `grant_id`, `account_id`, `project_id`, `resource_type`(enum), `resource_id`(uuid or path/slug), `principal_type`, `principal_id`, `effect`(reuse `scope_effect` enum), ts; `unique(project_id,resource_type,resource_id,principal_type,principal_id)` |

**New enum `iam_resource_type`** (forward-only `CREATE TYPE`, safe): `account, project, sandbox, trigger, channel, member, group` + new leaves `agent, skill, command, schedule, webhook, file, customize, gitops, secret, connector`. Mirror these into `RESOURCE_TYPES` ([actions.ts:9](apps/api/src/iam/actions.ts)) so `resourceTypeForAction` derives them.

**Seeding:** a data migration inserts `is_builtin=true` rows + `iam_role_actions` for the 6 roles **sourced verbatim from the role-perms.ts Sets**, so the DB path and the frozen-Set path are **byte-identical** (the cutover correctness test). `project_members` / `project_group_grants` stay the canonical **fast path**; `iam_policies` is consulted **additively (union)** — nothing existing breaks.

**Do NOT** add a 4th `project_role` enum value for the "User/Operator" tier. Model read+run as a **seeded custom role** (`key='user'`: read leaves + `session.start/exec/stop` + `trigger.fire`). Ships as data, no enum migration.

---

## 3. Action catalog (the granularity that makes "deactivate" possible)

Add to `PROJECT_ACTIONS` ([actions.ts:68](apps/api/src/iam/actions.ts)), `resource.verb[.subresource]`:

| Resource | read → VIEWER | write/verb → EDITOR |
|---|---|---|
| Agents | `project.agent.read` | `project.agent.write` |
| Skills | `project.skill.read` | `project.skill.write` |
| Commands | `project.command.read` | `project.command.write` |
| Schedules (cron config) | `project.schedule.read` | `project.schedule.write` |
| Webhooks (config only¹) | `project.webhook.read` | `project.webhook.write` |
| Files | `project.file.read` | `project.file.write` |
| Customize config | `project.customize.read` | `project.customize.write` |
| Git Ops (human side²) | `project.gitops.read` | `project.gitops.push`, `project.gitops.merge` |
| Secrets | `project.secret.read` | `project.secret.write` |
| Connectors | `project.connector.read` | `project.connector.write` |
| Deploy | *(exists)* | `project.deploy` (exists [actions.ts:72]; switch r5 deploy/stop off bare `manage`) |

¹ The inbound webhook **fire** path ([r1.ts:60](apps/api/src/projects/routes/r1.ts)) stays HMAC-authed — no user IAM. Only **config** is gated.
² `project.cr.open` / `project.cr.merge` already exist but are asserted for the **agent** scope only (r8/r9). The `gitops.*` leaves are the **human** gates.

**Backward-compat rule (non-negotiable):** every new WRITE leaf is added to `EDITOR_EXTRAS` and every READ leaf to `VIEWER_BASELINE` in the same change. Existing editors/managers keep **all** current capability. "Deactivate Git Ops" then = a **custom role that OMITS** `project.gitops.*`, never removing it from editor. (If you skip this, the 15s cache hides the regression in manual testing and editors get locked out on cache expiry.)

Also: wire `ROLE_* / POLICY_*` into `ADMIN_EXTRAS` (account) so admins can manage roles/policies; keep `VALID_ACTIONS` as the **write-time validator** for `iam_role_actions`.

---

## 4. Engine wiring (extend `authorizeV2`, don't replace)

1. `scopeForActionV2` unchanged (new project leaves already fall through to `project`).
2. Replace the single `Set.has()` with **`resolveEffectiveActions(actor, accountId, scope, target) → ReadonlySet<string>`**:
   - (a) start with the **frozen-Set** actions for the actor's built-in role (unchanged path — guarantees backward-compat),
   - (b) **UNION** in actions from every `iam_policies` row matching (principal = user **or** in `actor.groupIds` **or** = acting token) AND scope (account-wide applies everywhere; project where `scope_id = target.id`), resolving `role_id → iam_role_actions`; expired filtered in SQL,
   - (c) `effectiveActions.has(action)`.
3. **Hot-path guard:** add `resolveActorV2.hasCustomPolicies` (one cheap boolean) so accounts with no custom roles **skip the policy join entirely**. Built-in roles keep using the in-memory fast path.
4. Owner/admin/super_admin bypass **preserved exactly**.
5. **Cache revoke-invalidation** (the security fix): add `.invalidate(key)` / `.invalidateByPrefix(prefix)` to `ttl-memo.ts`; register the 4 IAM memos; invalidate on **every** grant/revoke — `grantProjectRole` ([access.ts:120]), group-grant CRUD (r7), group-membership writes (`scim/groups.ts`, `sso-sync.ts diffSsoGroups`, `accounts/iam/groups.ts`), and the new `iam_policies/iam_role_actions` writes. On a member change invalidate `${userId}|*` + `*|${projectId}|*`; on a group change invalidate all its members.

---

## 5. Three enforcement seams — **move together or a deactivation is cosmetic**

This is the single biggest correctness risk. A file-based resource (agents/skills/commands/memory) is committed via git/CR, so an API gate alone is bypassable via raw `git push`.

1. **API routes** (primary): copy the r6 Members pattern — `loadProjectForUser('write')` + explicit `assertAuthorized(leaf, {type:'project', id})`. Cover the **CR-merge path** too, not just direct edits.
2. **Sandbox / git-proxy** (Phase 4): `authorizeGitProxy` consumes the `GitScope` it already receives (receive-pack=write/upload-pack=read are already split at `git-proxy/index.ts:168`); gate write/push on the launching user's `project.gitops.push`; **stamp role caps into the session token** at mint (`session-sandbox.ts:106`, where `agentGrant` is already stamped). **DEFAULT-ALLOW legacy tokens with no caps stamped** or you break the entire boot fleet.
3. **Automation / tokens** (Phase 4): stamp the trigger owner's effective caps onto spawned session tokens; bridge service accounts via `iam_policies(principal_type='token')` with a **safe default** so Slack/cron don't 403.
4. **Frontend** (Phase 3): `useProjectCan(projectId, action)` via a **`:batch` probe** (one call, not ~13 fan-out per overlay open); map each of the 16 `CustomizeSection` → leaf action; gate the **rail item AND the deep-link route**; **default-hide on load/error**; invalidate iam-permission query keys on mutation; remove the dead `useCan` path.

**Department scoping path (the headline):** department = `account_group` (exists). Bind: `iam_policies{principal_type:'group', principal_id:group_id, role_id: Marketing-role, scope_type:'project', scope_id: company_project}`. SSO/SCIM already provision group membership end-to-end (`sso-sync.ts diffSsoGroups`, `scim/groups.ts`). "Can't **see** the rest" needs `iam_resource_grants` with **fail-CLOSED** default → Phase 4.

---

## 6. Phased rollout (each phase ships independently, backward-compatible)

| Phase | Goal | Ships | Risk |
|---|---|---|---|
| **0 — Cache revoke-invalidation** | Every grant/revoke takes effect immediately (any gate becomes a real boundary) | `ttl-memo` keyed invalidation + wire into all grant/group mutations + e2e asserting immediacy | **Low** — over-invalidation just costs a cache miss |
| **1 — Leaf actions + route gates** | Mint per-capability leaves; route each through explicit `assertAuthorized`; editors keep everything | `actions.ts` leaves + `RESOURCE_TYPES`; add to `EDITOR_EXTRAS`/`VIEWER_BASELINE`; migrate r3/r4/r5/r8/r9/r10 gates per-capability | **Med-High** — ~131 `loadProjectForUser` callsites; a missed route fails **open** to `project.write`. `e2e-projects-contract` mocks `assertAuthorized` to no-op (won't catch) → **live ke2e suite is the guard**. Migrate per-capability, not big-bang |
| **2 — DB custom roles** | Engine reads roles from DB; 6 built-ins seeded as `is_builtin`; enables capability deactivation | `iam_roles`+`iam_role_actions`+enum (migration); seed migration; `resolveEffectiveActions` union + `hasCustomPolicies`; build the dark `/iam/roles`, `/iam/roles/:id/permissions`, `/iam/actions` backend; gate on `ROLE_*` | **Med** — touches hot authorize path. Mitigate: `hasCustomPolicies` short-circuit + **seed-equality test** (DB path == frozen-Set path for built-ins) |
| **3 — Policies + dept scoping + frontend** | Assign roles to members/groups @ project scope; the "one company project, scoped departments" flow + capability-toggle UI; seed read+run "User" role | `iam_policies` + engine union; `/iam/policies` CRUD; Roles tab + action-catalog checkbox matrix (wire dark `iam-client`); `useProjectCan` section gating; SA bridge | **Med** — wrong section→action map can hide sections from legit managers (gate rail + deep-link together, default-hide); SA bridge must default-allow legacy |
| **4 — Bypass seams + per-resource grants** | Enforce caps sandbox-side; resource-subset isolation (fail-closed) for true "can't see the rest" | `authorizeGitProxy` honors `GitScope` + token caps (default-allow legacy); trigger/SA cap stamping; `iam_resource_grants` + `isResourceAccessibleBy` (lift `share.ts`); group tab in SharingPicker | **High** — `authorizeGitProxy` is the auth point for **all** git traffic; too-strict breaks clone/push on every boot. **Ship behind a per-account flag; default-allow legacy** |

**Minimum to satisfy the headline ask:** Phases 0–3 deliver "one company project + departments via group + scoped custom role, with capabilities deactivated." Phase 4 (per-resource visibility isolation) is the highest-risk, lowest-certainty work — **defer unless "can't SEE the rest of the resources" (not just "can't touch") is a hard v1 requirement** (Open Q8).

---

## 7. Open product decisions for Ino (with recommendations)

1. **Owner/admin bypass:** owners/admins/super-admins bypass all project gates by design — department isolation only contains plain members + custom-role holders. Accept for v1, or build a "restricted admin"? → **Recommend accept** (big design fork otherwise).
2. **Deactivation semantics under union:** v1 is union/highest-wins, so a Marketing role that omits Git Ops gives **no** protection if the user **also** has plain editor via another group. Is "this role lacks it" enough, or do you need "this user is denied project-wide" (= explicit DENY, a v2 item)? → **Recommend v1 = union-only, documented; deny in v2.**
3. **`manage`→`project.write` collapse:** keep + add explicit leaf asserts (low risk, chosen here) vs. introduce a real `project.manage` and re-audit 47 callsites? → **Recommend keep-collapse.**
4. **"User/Operator" tier contents:** read-everything + `session.start/exec/stop` + `trigger.fire`? Also `connector.read`? `secret.read` (probably **not**)? → Need your persona definition for the 10-Marketing-operator.
5. **File-based resource keys:** `iam_resource_grants.resource_id` for agents/skills/commands uses **path/slug** (`.opencode/agent/*`, `kortix.toml [[agents]]`). Confirm the path convention is stable enough to key grants on, or do we need a resource registry first?
6. **Service-account default role:** what baseline should an unscoped SA get so existing Slack/automation doesn't break while we bridge `principal_type='token'`?
7. **Per-resource grant default = fail-CLOSED** (resource with any grant denies non-granted members) — inverts the existing `share.ts` "empty list = whole project". Confirm, and confirm it's scoped to **only** the new `iam_resource_grants` (don't change existing secret/session sharing defaults or you silently lock existing shares).
8. **Is Phase 4 (per-resource visibility) in v1?** Or do dept-as-group + scoped role (Phases 1–3) satisfy "one company project with departments"?

---

## 8. Risks & testing

- **Fail-open on a missed route** (Phase 1): a capability route not migrated keeps `project.write` (editor has it) — safe-ish but means the deactivation silently doesn't apply. The **route manifest / ke2e coverage gate** + `spec/end-to-end.md` updates per changed gate are the guard; the contract test's no-op `assertAuthorized` mock will NOT catch it.
- **Hot-path latency** (Phase 2): the policy join must be skipped via `hasCustomPolicies` for the common (no-custom-roles) account.
- **Seed equality** (Phase 2): a test must assert the DB-resolved action set for each built-in == the frozen-Set, both before and after cutover.
- **git-proxy blast radius** (Phase 4): default-allow legacy tokens + per-account flag; one too-strict gate breaks every session boot's clone/push.
- **Cache over-invalidation** (Phase 0): only costs a DB roundtrip — acceptable.
- Test layers: unit (engine resolve, seed equality, action-catalog completeness) + e2e (`e2e-projects-contract`, `unit-iam-*`, `unit-agent-scope`) + **live ke2e** (the real gate for route coverage). Reuse the `unit-iam-v2-engine` / `unit-iam-v2-role-perms` patterns.

---

## 9. Execution checklist (for "we do it together")

- [ ] **Decisions first** — answer Open Qs 1–8 (esp. 2, 4, 8 — they change scope).
- [ ] **Phase 0** — `ttl-memo` keyed invalidation + wire into all grant/group mutations + revoke-immediacy e2e. *(Standalone, low risk — can land before any decision.)*
- [ ] **Phase 1** — leaf actions + `RESOURCE_TYPES`; add to `EDITOR_EXTRAS`/`VIEWER_BASELINE`; migrate gates per-capability with ke2e coverage each.
- [ ] **Phase 2** — migration (`iam_roles`/`iam_role_actions`/enum, via the `migration` skill) + seed + `resolveEffectiveActions` union + `hasCustomPolicies` + dark `/iam/roles`+`/iam/actions` backend + seed-equality test.
- [ ] **Phase 3** — `iam_policies` + engine union + `/iam/policies` CRUD + "User" seed role + Roles UI (wire dark `iam-client`) + `useProjectCan` section gating + SA bridge.
- [ ] **Phase 4 (optional/flagged)** — `authorizeGitProxy` + token cap stamping + `iam_resource_grants` fail-closed + group tab.

**Reusable templates to lift, not rebuild:** `project_secret_grants` + `share.ts isSecretUsableBy` (resource grants), the r6 Members `loadProjectForUser + assertAuthorized` pattern (route gates), `agent-scope.ts` (role ∩ grant), `project_group_grants` (group→project→role), the additive role slices (seeds), the pre-built `iam-client.ts` types/endpoints (the contract).

---

## 10. Implementation progress (branch `feat/iam-rbac-v1`)

**Decisions taken (per §7 recommendations; revisit Q4/Q8 together):** accept owner/admin bypass (Q1); v1 union-only deactivation (Q2); keep `manage`→`project.write` collapse (Q3); defer Phase 4 unless "can't SEE the rest" is hard-required (Q8).

### ✅ Done & committed (all additive, tsc-clean, unit-tested, no lockout risk)

- **Phase 0 — cache revoke-invalidation.** `ttl-memo` gains `invalidate(key)` / `invalidateByPrefix(prefix)`; new `iam/cache-invalidation.ts` registry (push-based, no import cycle); the 4 authz memos register; the project-member memo key is unified to `userId`-first so one prefix busts all. Wired into every revoke/demote/role-change site: `grantProjectRole`, project-member + group-grant CRUD (r6/r7), account member remove/role/leave, super-admin toggle, group-membership repo helpers, SCIM users+groups, SSO JIT sync. Grants stay instant (nulls uncached); expiry self-heals within the TTL. Tests: `unit-ttl-memo`, `unit-iam-cache-invalidation`.
- **Phase 1a — leaf catalog + role seeds.** Added `project.{agent,skill,command,schedule,webhook,file,customize,gitops,secret,connector}.{read,write}` (+ `gitops.push/merge`) to `PROJECT_ACTIONS`; seeded every write leaf into Editor and read leaf into Viewer so no current capability is lost. Guarded by a backward-compat invariant test in `unit-iam-v2-role-perms`.
- **Phase 1b (partial) — route gates.** Asserted `project.deploy` (app deploy/stop, r5), `project.customize.write` (apps-config, r5), `project.gitops.merge` (CR merge, r9). Behavior-identical today; the hook a custom role omits to deactivate the capability.

### ⏳ Next (do together — needs the live ke2e suite + product calls)

1. **Finish Phase 1b route gates** (fail-OPEN if missed, so safe to complete incrementally; verify each with ke2e): secrets create/delete → `project.secret.write` (r3); connector config → `project.connector.write`; `[[apps]]` CRUD → `project.customize.write` (r4); CR create/commit-push → `project.gitops.push` (r8). **File-based agents/skills/commands/memory** are git files (no per-type route) → they stay under the generic write/CR gate in v1; per-type granularity is Phase 4 (path-keyed resource grants).
2. **Phase 2 — DB custom roles.** Migration `iam_roles` + `iam_role_actions` + `iam_resource_type` enum (use the `migration` skill); seed the 6 built-ins as `is_builtin` rows; engine `resolveEffectiveActions` union + `resolveActorV2.hasCustomPolicies` short-circuit (keeps the hot path off the policy join — and makes it a no-op for everyone until policies exist); build the dark `/iam/roles`, `/iam/roles/:id/permissions`, `/iam/actions` backend; wire `ROLE_*`/`POLICY_*` into `ADMIN_EXTRAS`. **Gate: a seed-equality test (DB-resolved set == frozen-Set for every built-in) before flipping the engine to consume the union.**
3. **Phase 3 — policies + frontend.** `iam_policies` + engine union over member/group/token principals; `/iam/policies` CRUD; seed the read+run **"User" role** (Q4 — confirm contents); Roles UI + capability checkbox matrix (wire the dark `iam-client`); `useProjectCan` batch section-gating in `customize-overlay.tsx`; SA bridge (`principal_type='token'`).
4. **Phase 4 (flagged) — bypass seams + resource grants.** `authorizeGitProxy` honoring `GitScope` + token caps (default-allow legacy); `iam_resource_grants` fail-closed; group tab in SharingPicker.

**Note:** until Phase 2 lands, the new leaves + Phase-1b gates are inert for built-in roles (everyone holds the leaves) — they're the groundwork. The first user-visible deactivation arrives with Phase 2 custom roles, which can immediately omit the **existing** `project.trigger.*` leaves (Schedules/Webhooks), `members.manage`, gateway.* etc., plus the Phase-1b-gated deploy/customize/gitops-merge.

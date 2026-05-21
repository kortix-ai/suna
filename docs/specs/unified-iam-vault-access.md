# Unified Access Control: IAM + Vault + Sessions

**Status:** Draft for review · **Owners:** @marko @ino @saumya · **Date:** 2026-05-21

> One sentence: collapse the three generations of access control into a single
> Cloudflare-style IAM system, and make secrets, OAuth credentials, and sandbox
> sessions **first-class scoped resources** inside it — owned by an account
> (personal *or* team), visible to everyone / select members / just you.

---

## 1. Why this doc exists

Today access control is **three systems stacked on top of each other**, and
secrets/OAuth/sessions live *outside* all of them as project-global blobs.
We want a single, granular, enterprise-grade model where:

- **Account** has members, groups, roles, policies (Cloudflare-style).
- **Project** has members (who are account members) and project-scoped policies.
- **Secrets / OAuth / sessions** are protected by the *same* policy engine and can
  be scoped to **everyone in a project**, **select members**, or **one member (you)**.
- A **personal account is just an account with one member**, so "your personal
  GitHub / email / Codex login" is simply *your personal account's vault* — and it
  travels with you into any team session you launch.

This doc specifies the end-state and a phased path that never breaks existing access.

---

## 2. Status quo (what actually exists today)

### 2.1 Three generations of access control

| Gen | Mechanism | Where | Reality |
|---|---|---|---|
| 1. **Basejump** | `account_user`, basejump `accounts` | `shared/resolve-account.ts`, `accounts/index.ts` (fallback read) | being lazy-migrated away |
| 2. **Native role enums** | `account_members.account_role` (owner/admin/member) + `project_members.project_role` (manager/editor/viewer) | `projects/access.ts`, and **20 direct `isAccountManager()` gates** in `projects/index.ts`, raw `accountRole !== 'owner'` checks in `accounts/index.ts` | **does ~95% of real enforcement** |
| 3. **IAM** (Ino, PR #3189) | `account_groups`, `account_group_members`, `iam_roles`, `iam_role_permissions`, `iam_policies` + `is_super_admin` | `apps/api/src/iam/*` | newest; **only 1 `authorize()` call** wired into project routes — the rest runs through legacy *bridges* in `iam/engine.ts` |

The IAM engine is well-built (single `authorize(user, account, action, target)`
chokepoint, scope model, deny-wins precedence, groups, `listAccessibleResources()`
for list-filtering, per-request memoisation, 19 unit tests). The problem is it is
**layered on top of** Gen 2, not instead of it. The `bridgeLegacyAccountRole` /
`bridgeLegacyProjectRole` functions synthesise IAM answers from the old enums so
nothing broke at merge — they are scaffolding for a migration that's ~10% done.

### 2.2 Current data model (relevant tables)

```
accounts(account_id, name, personal_account bool, …)        -- personal OR team
account_members(user_id, account_id, account_role, is_super_admin, …)
project_members(account_id, project_id, user_id, project_role, granted_by, …)

project_secrets(secret_id, project_id, name, value_enc, created_by, …)        -- PROJECT-GLOBAL
project_oauth_credentials(credential_id, project_id, provider_id,
                          refresh_enc, access_enc, expires, created_by, …)     -- PROJECT-GLOBAL
project_sessions(session_id, account_id, project_id, branch_name, …)          -- NO member/owner column
session_sandboxes(sandbox_id, session_id, account_id, project_id, …)          -- NO member/owner column
```

### 2.3 How secrets reach a sandbox (the critical path)

`projects/index.ts → buildSessionSandboxEnvVars({ accountId, projectId, sessionId, userId, … })`
already **receives the actor (`userId`)** but ignores it for scoping. It calls:

- `listProjectSecrets(projectId)` → **every** secret on the project, decrypted.
- `buildOpencodeAuthContent(projectId)` → **every** project OAuth credential.

…and spreads them into the sandbox env. So today *any* member who can start a
session in a project gets *all* of its secrets and OAuth logins.

### 2.4 Encryption

`projects/secrets.ts`: AES-256-GCM with a key derived via
`hkdf(API_KEY_SECRET, salt = projectId, info = 'kortix-project-secret-v1')`.
**The encryption key is bound to `projectId`.** Changing ownership to account/member
implies re-keying (see §8).

### 2.5 OAuth today

`projects/oauth.ts`: `SUPPORTED_OAUTH_PROVIDERS = ['openai', 'github-copilot']`,
stored per project, injected as opencode auth. There is **no per-member OAuth**, so
"connect *your* GitHub / Slack / email / Codex" is impossible today.

### 2.6 Prior art (already sketched, now removed)

A `vault_items` table existed in the dev DB (empty, not in the Drizzle schema, no
code refs — dropped 2026-05-21 during the schema resync). Its shape is **exactly
this spec's direction** and should be the reference:

```
vault_item_kind       ∈ { env, api_key, oauth_token, oauth_client, connection_secret }
vault_item_visibility ∈ { private, project, account }
```

---

## 3. Core thesis — one access model

Every protectable thing — a project, a sandbox, a trigger, a channel, **a secret,
an OAuth credential, a session** — is a *resource* with a `(type, id)`. Access to
any of them is decided by the **same** function:

```
authorize(userId, accountId, action, target?: { type, id }) → allow | deny
```

…against the **same** policy table (`iam_policies`), which binds a **principal**
(member or group) to a **role** on a **scope** with an **effect** (allow/deny).
Adding secrets/sessions to the system = adding new `scope_type`/`resource_type`
values and the actions for them. **No second system.**

The only twist secrets add is **default-global semantics** (sharing-first), which
we model explicitly (see §5.3) rather than IAM's default-deny.

---

## 4. The unified vault — ownership model

Replace `project_secrets` + `project_oauth_credentials` with **one** account-owned
vault. This is the heart of the spec.

```
vault_items(
  item_id        uuid pk,
  owner_account_id uuid not null → accounts,     -- the OWNER. personal OR team account.
  kind           vault_item_kind not null,       -- env | api_key | oauth_token | oauth_client | connection_secret
  name           varchar not null,               -- env var name (UPPER_SNAKE) or provider id for oauth
  value_enc      text not null,                  -- AES-256-GCM envelope (see §8)
  -- SCOPE: where, within the owner account, this item applies --------------
  project_id     uuid null → projects,           -- null = account-wide; set = this project only
  owner_user_id  uuid null,                       -- set = PRIVATE to that member; null = shared
  -- metadata --------------------------------------------------------------
  provider_id    varchar null,                   -- for oauth kinds: 'github' | 'slack' | 'openai' | 'google' | …
  metadata       jsonb default '{}',
  created_by     uuid, created_at, updated_at
)

vault_item_grants(                                -- the "select members" list (only for shared items)
  item_id uuid → vault_items,
  user_id uuid,
  primary key (item_id, user_id)
)
```

### 4.1 The three ownership levels the product needs

These fall straight out of `(owner_account_id, project_id, owner_user_id)`:

| Level | How it's expressed | Example |
|---|---|---|
| **Member / personal** | `owner_user_id = you` | your personal GitHub, your email, your Codex login |
| **Account-wide (team)** | `owner_user_id = null`, `project_id = null` | org-wide Stripe key shared by all members |
| **Project (team)** | `owner_user_id = null`, `project_id = X` | a key only Project X's sandboxes need |

…and a **personal account** (`accounts.personal_account = true`, one member) is
simply the case where the owner account *is* you. "Your personal vault" = the vault
of your personal account. Nothing special — same table.

### 4.2 Shared vs select-members (the "default-global" rule)

For a **shared** item (`owner_user_id = null`):

- **No rows in `vault_item_grants`** → **everyone** in the scope can use it
  (every project member for a project item; every account member for an account item).
- **≥1 row in `vault_item_grants`** → **only those members** can use it; any of them
  can add more. This is exactly Marko's *"by default if empty, global; if at least
  one member, that member has access & might add more."*

This is the simple Global / Private / Select-members UX, with `owner_user_id` giving
"Private (just you)" and `grants` giving "Select members". **Groups can be added
later** by allowing a `group_id` in `vault_item_grants` — same table, no migration.

---

## 5. Resolution rules (the decision-fatigue killer)

When actor **U** boots a session in account **A**, project **P**, we assemble the
env/auth set by collecting every vault item U is allowed to use, then resolving
**name collisions by specificity — most specific wins, silently**:

```
precedence (high → low) for the same `name`:
  1. U's PRIVATE item in (A, P)         owner_user_id=U, project_id=P
  2. U's PRIVATE item in (A, account)   owner_user_id=U, project_id=null
  3. U's PERSONAL-account item          owner_account_id=U's personal acct      ← "your personal variant wins for you"
  4. SHARED select-members item in (A,P) that lists U
  5. SHARED global item in (A, P)
  6. SHARED account-wide item in (A)
```

So if you have a personal `OPENAI_KEY` and the team has a global one, **yours wins
for your sessions, automatically — no prompt.** Marko's worry ("which of 2 keys to
use… decision fatigue") is resolved by a deterministic rule, not a UI choice.

> Open question (§11): is order #3 (personal-account) above or below team project
> secrets? Default proposed: **personal wins** (your creds are "yours"), but a team
> may want to *force* a shared key — handle via an admin "lock" flag on the shared
> item that bumps it above personal.

---

## 6. Sessions must mirror secret scope

**The load-bearing coupling.** Secrets materialise as env vars *inside a sandbox
session*. A private/member-scoped secret would leak through a shared session.
Therefore session ownership must be expressible too.

Add to `project_sessions` (and `session_sandboxes`):

```
owner_user_id   uuid null,                 -- the member who owns this session
session_scope   enum('project','member','ephemeral') default 'member'
```

| `session_scope` | Meaning | Secret set injected |
|---|---|---|
| **project** | shared workspace any project member can attach to | shared items only (no member-private) |
| **member** | owned by `owner_user_id` | shared items + that member's private/personal items (per §5) |
| **ephemeral** | single-use (trigger/channel run) | resolved for the *acting* member only |

Injection becomes: `buildSessionSandboxEnvVars` already has `userId` — swap
`listProjectSecrets(projectId)` for `resolveVaultForActor({ accountId, projectId,
userId, sessionScope })` implementing §5. **No call-site plumbing needed.**

For **non-interactive** runs (channels/triggers via `agent-bridge.ts`, which today
resolves a single actor through `resolveGitTriggerActor(accountId)`): the resolved
actor is the member whose private/personal vault is used. A trigger with no bound
member gets shared-only secrets.

---

## 7. IAM integration (one engine)

Extend the existing catalog rather than inventing a parallel one:

- **`resource_type` / `scope_type`**: add `secret` and `session` (the enums already
  include `account, project, sandbox, trigger, channel, member, group`).
- **Actions** (new): `secret.read`, `secret.write`, `secret.use`, `secret.share`,
  `session.create`, `session.read`, `session.delete`, plus oauth as a secret kind so
  `secret.*` covers it.
- **Vault access check** = `authorize(U, A, 'secret.use', { type:'secret', id })`,
  where the policy set is *derived* from the vault ownership/grants in §4–5 (we can
  either store real `iam_policies` rows per grant, or evaluate grants directly in a
  vault resolver that shares the engine's precedence helpers — see §11).
- Admin operations on the vault (`secret.write`/`share`) are gated by IAM like any
  other route, so an account admin/`super_admin` manages everyone's shared items, a
  member manages only their own private items.

---

## 8. Encryption & key management

Today the key is bound to `projectId`. Vault items are account-owned and may be
account-wide (no project) or personal, so:

- Derive the item key from **`owner_account_id`** (stable) instead of `projectId`:
  `hkdf(API_KEY_SECRET, salt = owner_account_id, info = 'kortix-vault-v2')`.
- Bump the envelope version (`v1` → `v2`) so old `project_secrets` envelopes remain
  decryptable during migration; re-encrypt on read/write.
- Personal-account items use the personal account id as salt — same code path.
- (Future) per-account DEK wrapped by a KMS root, if we want hardware-backed keys
  for enterprise. Out of scope for v1 but the `owner_account_id` salt keeps the door
  open.

---

## 9. API surface (sketch)

```
# Vault (replaces /projects/:id/secrets and /projects/:id/oauth)
GET    /v1/accounts/:accountId/vault                 ?project_id=&kind=&mine=true
POST   /v1/accounts/:accountId/vault                 { kind,name,value,project_id?,visibility, grants[] }
PATCH  /v1/accounts/:accountId/vault/:itemId         { value?, grants?, visibility? }
DELETE /v1/accounts/:accountId/vault/:itemId
POST   /v1/accounts/:accountId/vault/:itemId/grants  { user_ids[] }     # select-members
# OAuth connect (writes a vault item of kind=oauth_*)
GET    /v1/accounts/:accountId/vault/oauth/:provider/start   ?scope=personal|account|project:<id>
GET    /v1/accounts/:accountId/vault/oauth/:provider/callback
```

`visibility` is UX sugar that the API translates to the §4 columns:
`global` → shared+no grants, `private` → `owner_user_id=caller`, `select` → shared+grants.

---

## 10. UX — one question, every time

Per Marko: adding **any** secret/integration always asks the same thing:

> **Who can use this?**  ●  Everyone on the project   ○  Only me   ○  Select members…

Plus a scope toggle for shared items: **This project** vs **Whole account**. OAuth
"Connect" buttons (GitHub, Slack, Google, OpenAI, Codex, personal email) write the
same vault item with `kind=oauth_*` and the chosen visibility. One mental model for
env vars, API keys, and logins alike.

---

## 11. Decisions & open questions

### Decided (2026-05-21 review)

- **Unify on PRINCIPAL, not on account.** Tempting to make org/member/group all
  one `accounts` row with a uniform id; rejected. That forces accounts to carry a
  `type` (org/personal/group) plus conditional rules ("groups can't bill", "personal
  accounts have no sub-members"), and invites recursive nesting. Instead: `accounts`
  = container only (personal **or** team); the uniform handle is IAM's
  `principal_type ∈ {member, group, token}` + `principal_id`, which already exists.
  *That* is "everything is a principal" without the type-zoo.
- **Flat, no nesting.** No account-tree / sub-accounts / transitive membership. One
  account contains members + groups. (Recursive org trees = AWS-Organizations-grade
  complexity we don't need.)
- **Groups deferred for v1.** Groups (sets of people) are orthogonal to projects
  (resources), not redundant — but per-member policies cover v1. The
  `principal_type='group'` column stays, so adding groups later is free.
- **Single `owner_account_id` per vault item.** No multi-owner. "Org owns it" = the
  org account is the owner; "a group owns it" = an org item granted to that group
  later. Co-ownership is a *sharing* (grants) concern, not ownership. Single owner
  also keeps one encryption key per item (§8).

### Still open

1. **Personal vs team precedence** (§5): does a member's personal key override a
   team's shared key for that member's sessions? Proposed **yes**, with an admin
   "lock/force shared" flag as the escape hatch.
2. **Policies-as-rows vs vault-native grants** (§7): store each grant as a real
   `iam_policies` row (pure one-system, but row explosion), or keep `vault_items` +
   `vault_item_grants` and have a *vault resolver* reuse the engine's precedence
   (less data, slight duplication)? Proposed **vault-native grants** for v1.
3. **Project membership = project-scoped policy?** Keep `project_members` as a
   roster table, or define "project member" purely as "has any policy scoped to that
   project"? Affects whether `project_role` survives.
4. **Account ownership/billing**: split `account_role` into a billing **owner
   pointer** + IAM permissions, so we can drop the permission meaning of the enum.

> Note: provider-OAuth "adding" was removed wholesale on 2026-05-21 (see git +
> migration `…56`). OAuth re-enters only via this vault as `kind=oauth_*`.

---

## 12. Phased rollout (never breaks existing access)

> Depends on first consolidating IAM into the sole authority — see the companion
> work below. Building vault scoping before IAM is the single authority means
> writing the checks twice.

**Phase 0 — IAM becomes the sole runtime authority (no behavior change).**
Replace the 20 `isAccountManager()` gates + raw `accountRole !==` checks with
`assertAuthorized(userId, accountId, action, target)`. Keep the legacy bridges ON so
every flipped route behaves identically. *This is the real "one system" win.*

**Phase 1 — Backfill + delete bridges.** Migrate `account_role` / `project_members`
into explicit `iam_policies`; remove `bridgeLegacyAccountRole` /
`bridgeLegacyProjectRole`. Policies become the single source of truth.

**Phase 2 — Vault data model.** Create `vault_items` + `vault_item_grants`; migrate
`project_secrets` (→ shared, project-scoped, global) and `project_oauth_credentials`
(→ `kind=oauth_*`, project-scoped, global) into it. Re-key to `owner_account_id`
salt (§8). Dual-read during cutover.

**Phase 3 — Member-scoped sessions.** Add `owner_user_id` + `session_scope` to
`project_sessions`/`session_sandboxes`; swap injection to
`resolveVaultForActor(...)` (§6).

**Phase 4 — Personal & select-member secrets + OAuth connect.** Ship the
"Who can use this?" UX, personal-account vault, and per-member OAuth (GitHub, Slack,
Google, email, Codex). Add group-scoped grants (decision #5).

**Phase 5 — Retire basejump (Gen 1).** Finish `account_user → account_members`,
delete the lazy-migration fallback and basejump schema reads. Independent.

---

## Appendix — file/symbol index (for implementers)

- IAM engine & precedence: `apps/api/src/iam/engine.ts` (`authorize`, `policyMatchesTarget`, `listAccessibleResources`, the two `bridge*` fns).
- IAM REST: `apps/api/src/accounts/iam.ts`; client `apps/web/src/lib/iam-client.ts`.
- Legacy gates to replace: `apps/api/src/projects/index.ts` (`isAccountManager`, `getAccountMembership`, `getProjectMemberRole`, `effectiveProjectRole`), `apps/api/src/projects/access.ts`, `apps/api/src/accounts/index.ts`.
- Secrets: `apps/api/src/projects/secrets.ts` (encryption + `listProjectSecrets`); injection in `projects/index.ts::buildSessionSandboxEnvVars`.
- OAuth: `apps/api/src/projects/oauth.ts` (`SUPPORTED_OAUTH_PROVIDERS`, `buildOpencodeAuthContent`).
- Sessions/sandboxes: schema in `packages/db/src/schema/kortix.ts` (`projectSessions`, `sessionSandboxes`); channel/trigger actor in `apps/api/src/channels/agent-bridge.ts` (`resolveGitTriggerActor`).
- Schema: `packages/db/src/schema/kortix.ts`. Migrations: `supabase/migrations/` (IAM = `…54_iam_*`, `…55_iam_*`).

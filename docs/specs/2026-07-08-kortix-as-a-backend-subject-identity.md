# Kortix as a Backend — The Subject Identity Model

**Status:** Proposal + foundation implementation — Marko + Fable, 2026-07-08. Items 1–4
(Subject principal, subject-scoped session token, secret-less runtime, executor-grant
default) land as an **additive, feature-flagged** foundation PR — default behavior is
unchanged; the enforcing flags stay **off** until security review. Items 5–17 are the
persisted backlog (§6). This doc is the durable source of truth for the whole
"Kortix as a backend / verticalized wrapper" thread.

**Depends on:** `docs/specs/2026-06-28-token-session-agent-identity.md` (the token
contract this extends), `docs/specs/2026-07-05-agent-first-config-unification.md`
(agent-first, Phase 4 git boundary), `docs/AUTHZ_MODEL_FINAL_PLAN.md` (§5b secret-less
runtime, §7b git-optional/CMS mode).

**Companion artifacts (visual):** the Trust-Boundary thesis and the Two-Plane
consumption map produced alongside this doc.

---

## 0. The one-sentence thesis

**Kortix's entire security model assumes the person driving the agent is a trusted
insider. Wrapping Kortix as a backend inverts exactly that assumption — and every
concern in this document is a consequence of that single inversion.**

The fix is one new principal — the **Subject**: an opaque external end-user identity the
operator asserts through their own API key. Kortix never authenticates the Subject; it
trusts the operator's assertion and issues a token *scoped to that Subject*. Every
capability the "backend" use case needs (per-end-user isolation, per-user credentials,
per-user budgets/model caps, protected agent IP, safe browser tokens) becomes a property
of the Subject. **The verticalized-wrapper question and the untrusted-driver question are
the same body of work.**

---

## 1. Two framings, one boundary

### 1a. Trust boundary (untrusted driver)
Today the sandbox sits **inside** the trust boundary: it holds plaintext secrets, the
full git history, a reusable model OAuth credential, and a real account-privileged PAT.
That is correct when the driver is a trusted teammate. When an untrusted end-user drives
the agent, the sandbox is effectively controlled by the adversary, so the boundary must
move: **the sandbox becomes an untrusted zone**, and everything sensitive retreats behind
a server-side proxy the driver's privilege cannot cross.

### 1b. Two planes (verticalized wrapper)
Every Kortix primitive lives in a **control plane** (operator configures once — git
authored, editor/manager role) or a **runtime plane** (end-user touches every session —
floor `member` role). The line between them is drawn by one permission,
`project.customize.write`. A verticalized wrapper serves only the runtime plane and keeps
100% of the control plane private. **This mostly works today** (see §3) — the built-in
`member` role already is a "run the agent, can't build it" role. The Subject work closes
the three places the plane leaks.

Both framings converge on the same primitive. §2 is the design.

---

## 2. The design — items 1–4

### Item 1 — Subject principal

A **Subject** is an external identity namespaced to a project (or account), asserted by
the operator. It is *not* a Kortix login, not a Supabase auth user, and never a
`project_members` row.

- New table `subjects`: `(subject_id uuid pk, account_id, project_id, external_ref text,
  display_name, metadata jsonb, created_at, disabled_at)`. `external_ref` is the
  operator's own end-user id (unique per project). No FK to `auth.users`.
- Subjects are created/asserted programmatically by an **operator credential** (a
  `kortix_pat_` acting as the operator, or a service account with the right grant).
  Idempotent upsert on `(project_id, external_ref)`.
- A Subject carries **no ambient authority**. It only becomes meaningful when a
  subject-scoped session token is minted for it (Item 2). This keeps the Subject a pure
  identity, not a role — authorization stays in IAM + the token grant.

*Why a new principal and not a `project_members` row:* members require a real Supabase
auth user (email invite / `lookupUserIdByEmail`), cannot be bulk-minted (even SCIM only
creates pending invites), and every member in a shared project can see every other
member's sessions (floor `member` has `project.session.read`). Subjects are cheap,
headless, and isolatable.

### Item 2 — Subject-scoped session token

Today's session executor token (`docs/specs/2026-06-28-token-session-agent-identity.md`)
is a real account PAT that acts **as the launching user**, carries `project_id`,
`session_id`, `agent_grant`, and — critically — `session_id` is **metadata, never an
access boundary** (`enforceTokenProjectScope`, `apps/api/src/middleware/auth.ts:612-658`,
gates project only). We add a **subject-scoped** variant:

- Same `account_tokens` row shape, plus a new `subject_id` column and a
  `backend_scoped boolean` flag.
- When `backend_scoped = true`, the token:
  - is bound to **exactly one `session_id`** and that binding **is enforced** — any
    request whose `:sessionId` (path or body) differs from the token's is `403`. This is
    the missing boundary; it is the whole point.
  - carries an **interact-only** grant: may prompt/stream/answer-permission on its one
    session; may **not** read secrets, open/merge change requests, read other sessions,
    or reach any account route. Implemented as a locked `agent_grant`
    (`kortixCli: []`, `secrets: []`) plus a hard route allowlist independent of role.
  - has a **short TTL** (minutes), refreshable only by the operator's BFF (which holds
    the operator credential), never by the browser.
- Minting endpoint: `POST /v1/projects/:projectId/subjects/:externalRef/session-token`
  — operator credential in, `{ session_id, token, expires_at }` out. The operator's BFF
  creates/ensures the session, mints the subject-scoped token, hands *only that* to the
  end-user's browser.

This is the token a third party may safely put in an untrusted browser. It replaces the
current unsafe options: (a) hand over the operator's full JWT/PAT, or (b) the fixed-shape
`kps_` public share (read-only, single-resource, no interactivity).

### Item 3 — Secret-less runtime (backend mode)

A per-project **backend mode** flag (`projects.metadata.backend_mode` /
`KORTIX_BACKEND_MODE` platform default off). When a session is provisioned in backend
mode:

- **No plaintext project secrets** are injected into the sandbox env. Today
  `listProjectSecretsSnapshotForUser` decrypts every `runtime` secret into
  `agent-env.sh` (`apps/kortix-sandbox-agent-server/src/agent-env-file.ts:142-159`),
  readable by the agent's `bash` tool. In backend mode this snapshot is empty; secrets
  are resolved **server-side per call** only (the connector/executor path already does
  this correctly — extend the same discipline to any secret the agent needs).
- **No account-privileged PAT** in the sandbox. Today the LLM key *is* the executor token
  *is* a real account PAT valid on the general API
  (`apps/api/src/platform/services/session-sandbox.ts:322-360`). In backend mode the
  sandbox holds only the subject-scoped, interact-only token (Item 2) and the LLM proxy
  token, both budget-capped.
- **No reusable model OAuth on disk** (`CODEX_AUTH_JSON`,
  `apps/kortix-sandbox-agent-server/src/opencode.ts:487-511`).
- **Scoped clone** (overlaps Item 7): no full history; exclude `.kortix/` agent+skill IP.
- **Capped LLM spend**: backend-mode sessions get a default block-budget so an end-user
  can't drain the operator's wallet (today spend is uncapped absent an explicit
  `gateway_budgets` block, `apps/api/src/llm-gateway/hooks.ts:139-172`).

Aligns with `AUTHZ_MODEL_FINAL_PLAN.md` §5b ("stop injecting project runtime secrets at
boot; resolve per-call server-side; the sandbox holds exactly one opaque agent-scoped
token and no raw credentials").

### Item 4 — Fix the default executor grant

Today, a project that has **not** adopted `[[agents]]` resolves the session grant to
`null` = **unrestricted** (capped only by the launching human's role):
`grantFromLoadedAgents` / `agentMayUseEnv` treat "no grant" as "no restriction"
(`apps/api/src/iam/agent-scope.ts:62-71`, `apps/api/src/projects/agents.ts:280-335`). For
a backend-mode project this is unacceptable — the session can read all secrets, open/merge
CRs, and reach the launcher's other sessions.

- In **backend mode**, "no grant" flips to **default-deny** (least privilege): the
  subject-scoped token gets an explicit minimal grant, never the ambient `null`.
- Outside backend mode, behavior is **unchanged** (the `default` sentinel stays
  non-binding per the token-identity spec) — this is the back-compat contract we must not
  break.

---

## 3. Current-state facts (verified by code audit, file:line)

### What breaks under an untrusted driver
- **Full clone forced every session**, incl. reachable history — a deleted-then-recommitted
  secret is recoverable via `git show`. `apps/api/src/projects/lib/sessions.ts:302-310`
  (`KORTIX_CLONE_FILTER=''`).
- **Plaintext secrets in sandbox env**, readable by the agent's `bash`. Provider keys are
  only withheld from the opencode *process*, not the container.
  `apps/kortix-sandbox-agent-server/src/agent-env-file.ts:142-159`,
  `.../opencode.ts:628-646`.
- **Reusable model OAuth on disk.** `.../opencode.ts:487-511` (`CODEX_AUTH_JSON`).
- **LLM key = executor token = account PAT**, valid on general API, uncapped spend.
  `apps/api/src/platform/services/session-sandbox.ts:322-360`,
  `apps/api/src/llm-gateway/hooks.ts:139-172`.
- **`session_id` is not an access boundary.** `apps/api/src/middleware/auth.ts:612-658`
  (project scope only).
- **Default executor grant is unrestricted.** `apps/api/src/iam/agent-scope.ts:62-71`,
  `apps/api/src/projects/agents.ts:280-335`.
- **Git-proxy `_scope` is unused** → session clones whole repo regardless of resource
  grants. `apps/api/src/projects/lib/git.ts:582-611`; acknowledged
  `docs/AUTHZ_MODEL_FINAL_PLAN.md:36-43`.

### Connector/profile corollary
- Every connector resolves **one shared project credential** —
  `resolveCredential(connector, null)` is hard-coded.
  `apps/api/src/executor/gateway.ts:300`. Per-end-user switching is *impossible* today.
- `per_user` mode was deliberately removed 2026-07-05 (correct reasoning: leaked launcher
  identity, no answer for triggers). The redesign ("connect your own account", interactive
  only) is parked in `2026-07-05-agent-first-config-unification.md` §2.5.
- Pipedream's `external_user_id` already computes `projectId:slug:userId`
  (`apps/api/src/executor/pipedream.ts:49-59`) — subject-ready; every write path just
  passes `null`.

### Tenancy / billing
- Billing is **one fungible per-account wallet** (`credit_accounts` keyed by `accountId`).
  No native per-project/per-user sub-wallet.
- **No external end-user identity exists anywhere** — every principal traces to a real
  Supabase auth user; even SCIM can't bulk-mint logins.
- Metering *is* reconstructable: `usage_events` / `gateway_request_logs` carry
  `accountId`, `projectId`, `sessionId`, `actorUserId`; `gateway.budgets()` returns a
  per-`actorUserId` breakdown — but only differentiates end-users if each is a distinct
  Kortix principal.
- Ceilings that bite at scale: concurrent sessions capped per-account (enterprise 5000,
  paid 200), `MAX_PROJECTS_PER_ACCOUNT=200`, `GET /v1/projects` unpaginated.

### What already works for a vertical (the good news)
- **Floor `member` role IS the end-user role.** `session.start/stop/read` +
  read-only + `review.submit` + `trigger.fire`, and **sees zero Customize sections**
  (all gated on `project.customize.write`, editor-tier).
  `apps/api/src/iam/role-perms.ts:137-178`; customize gate
  `apps/web/src/lib/project-actions.ts:161-167`.
- **One locked agent, enforced at the door.** New projects stamped
  `require_declared_agents: true` at provision (`apps/api/src/projects/routes/r1.ts:454`);
  a one-agent manifest makes any other `agent_name` a hard `400 AGENT_NOT_DECLARED`.
- **Config-as-git is the operator moat** — agents/skills/connectors/triggers/policies/
  sandbox spec all git-authored; end-users never author config.
- **Skills grants have runtime teeth** — compile to an allow/deny `permission.skill` tree,
  deny-by-default in v2. `apps/api/src/projects/lib/compile-agent-config.ts:293-371`.
- **SDK covers almost the whole control plane** — connectors, secrets, triggers, channels,
  CRs, review, sandbox, apps, gateway, billing, access, marketplace all have facades.

### Expressiveness verdicts (IAM)
- (a) Silo end-users in a **shared** project — **not expressible** (floor `member` has
  `session.read`; no per-session-owner grant). → native isolation is **project-per-end-user**.
- (b) Pre-built agent, invoke-not-edit — **expressible** (`agent.write` is editor-tier).
- (c) Operator-only secrets/config — **expressible** (floor `member` excludes
  `secret.read`/`connector.write`/`customize.write`).
- (d) Custom "vertical-end-user" role below the `member` floor — **expressible only if the
  principal has no `project_members`/group row** (IAM is allow-only union; a built-in role
  can't be subtracted).
- (e) ASK/approval on specific tool calls — **expressible** via System B (`[[policies]]`
  in `kortix.toml`, enforced in the executor gateway), *not* the IAM `iam_policies` table.

---

## 4. Feature-by-feature consumption map (the vertical's cheat-sheet)

| Primitive | Mode | Config | SDK | Locked by floor role |
|---|---|---|---|---|
| Agent identity/persona | Pre-configure | `kortix.yaml` + `agents/*.md` (git) | partial (scope-narrow only) | yes (`agent.write`=editor) |
| Skills | Pre-configure | `.kortix/opencode/skills/` (git) | list-only (CRUD web-local) | yes |
| Secrets | Pre-configure & hide | names git · values DB | full | yes (member can't read values) |
| Connectors | Pre-configure + remap creds | `[[connectors]]` git + DB | full CRUD | yes |
| Triggers | Pre-configure / expose fire | `[[triggers]]` git | full | split (read+fire; create=editor) |
| Channels | Hide / bypass | DB (v2) | full | yes |
| Memory | Runtime write | `.kortix/memory/*.md` git | file I/O | merge-gated (CR) |
| Change Requests / Review | Expose submit / hide merge | DB + git | full | split (submit; act/merge=editor) |
| Sessions / Sandbox | Expose (the product) | DB · spec git | full | open by design |
| Apps / Deploys | Hide / bypass | `[[apps]]` git | full | yes (deploy=editor) |
| Models | Default (can't hard-pin) | agent `.md` git | budgets/keys | not IAM-gated (explicit wins) |
| Approval policy | Pre-configure + runtime prompt | `[[policies]]` git | full | split |
| Billing / credits | Hide · operator re-bills | account DB | read + curated | account-scoped |
| Marketplace | Hide / bypass | catalog ext · install git | full | yes (install=editor) |
| Projects & IAM | Operator-only + remap identity | DB | project yes · account no | the lock itself |

---

## 5. Sequencing

- **P0 (this PR, feature-flagged):** Item 1 Subject principal · Item 2 subject-scoped
  session token (session_id boundary) · Item 3 secret-less runtime · Item 4 default-deny
  grant in backend mode. Additive; flags default off.
- **P1:** Item 5 per-subject credential resolution (un-null the resolver) · Item 6
  per-subject budget/model caps · Item 7 scoped clone + git boundary · Item 8 model pin ·
  Item 9 default LLM cap.
- **P2:** Item 10 account-scoped IAM in SDK · Item 11 skills CRUD + web-local ports ·
  Item 12 git-optional/CMS mode · Item 13 per-subject metering API · Item 14 per-turn
  token re-mint → re-enable agent lock.
- **Ship-now (no platform change):** Item 15 vanilla-TS BFF reference app · Item 16
  "Kortix as a backend" hardening guide · Item 17 replace whitelabel-demo stubs.

---

## 6. The full backlog (items 5–17) — persisted with evidence

**P1 — platform-only, can't be engineered around by the customer**

5. **Per-subject credential resolution.** Un-hardcode
   `resolveCredential(connector, null)` (`apps/api/src/executor/gateway.ts:300`) to key on
   `subjectId`. Revive "connect your own account" (interactive-only) from
   `2026-07-05-agent-first-config-unification.md` §2.5. Pipedream already supports
   `projectId:slug:subjectId` (`apps/api/src/executor/pipedream.ts:49-59`).
6. **Per-subject budget + model entitlement caps.** Extend `gateway_budgets` (already has
   a `member` scope keyed by subject-ish `subjectUserId`) to a `subject` scope; cap spend,
   concurrency, and which models a subject may pick.
7. **Scoped clone + git boundary.** Honor the unused `_scope` in `authorizeGitProxy`
   (`apps/api/src/projects/lib/git.ts:582-611`); sparse-checkout to exclude `.kortix/`
   agent+skill IP; blobless/no-history so deleted secrets aren't recoverable. This is
   agent-first **Phase 4**, currently OPEN.
8. **Model pin that survives explicit override.** Today explicit
   `opencode_model`/per-message model always beats `agent.model`
   (`apps/kortix-sandbox-agent-server/src/__tests__/resolve-opencode-model.test.ts`); only
   tier/entitlement gates it, never agent identity. Add an agent/subject-level hard pin.
9. **Default LLM spend cap.** Backend-mode sessions (and ideally all sessions) get a
   default block-budget; today spend is unbounded absent an explicit block
   (`apps/api/src/llm-gateway/hooks.ts:139-172`, `.../budgets.ts:25-52`).

**P2 — completeness / DX for a clean "backend" story**

10. **Account-scoped IAM in the SDK.** Custom roles, policy bindings, groups, service
    accounts, SCIM, SSO are REST-only under `/v1/accounts/:id/iam/*`; the dashboard calls
    them via `apps/web/src/lib/iam-client.ts`, `@kortix/sdk` has no wrapper
    (`packages/sdk/API-MAP.md:229-237`). A backend wrapper shouldn't reverse-engineer
    dashboard calls.
11. **Skills CRUD + remaining web-local ports.** Skills create/update/delete is web-local
    (`packages/sdk/API-MAP.md:90`); also executor runtime connector calls, Review Center
    hooks, connector OAuth flows.
12. **Git-optional / CMS mode.** Make `repo_url`/`branch`/`manifest_path` optional; move
    GitHub-specifics out of SDK core; project config can come from git **or** the API.
    `AUTHZ_MODEL_FINAL_PLAN.md` §7b ("what unlocks wrapping Kortix as a generic backend").
13. **Per-subject metering read API.** `usage-history` has no actor filter
    (`apps/api/src/billing/routes/credits.ts:188-206`); add a usage-by-subject endpoint so
    a wrapper can re-bill cleanly without inviting one real member per end-user.
14. **Per-turn token re-mint → re-enable agent lock.** The correct model behind
    `KORTIX_ENFORCE_SESSION_AGENT_LOCK` (off today); already written up in
    `docs/specs/2026-06-28-agent-defaults-todo.md`.

**Ship-now — customer best-practice, we enable + document**

15. **Vanilla-TS BFF reference app** (DeepAI shape, no React): project-per-end-user,
    one declared agent, floor-`member` PATs, model picker omitted, tools hitting the
    operator's proxy. A twin of `apps/whitelabel-demo` wrapper mode without the React/Next
    coupling — the SDK core is mechanically framework-agnostic
    (`packages/sdk/src/index.isomorphic.test.ts`), and `@kortix/sdk/server`'s
    `createScopedKortix` (AsyncLocalStorage) is purpose-built for a multi-end-user BFF.
16. **"Kortix as a backend" hardening guide.** Codify the best-practices: agent isolation,
    own-proxy egress for tools, authorization-rule patterns, and the explicit list of what
    must never reach the sandbox. Highest-leverage near-term deliverable for DeepAI.
17. **Replace `whitelabel-demo` stubs** (file-based user store, hand-rolled proxy policy)
    with the real primitives as P0/P1 land.

---

## 7. The hard ceiling until P0 lands

Until Items 2–3 ship, one rule holds for any untrusted-end-user deployment: **the
end-user may never hold a Kortix token, and never drive the agent's shell/tools directly.**
Everything routes through the operator's BFF — the end-user sends prompts and sees
sanitized transcript output; the BFF holds the only credential. The moment an untrusted
end-user reaches anything inside the sandbox, they hold the operator's PAT, secrets, and
reusable OAuth creds. That is the current architecture working exactly as designed for a
*different* threat model.

---

## 8. Open questions

1. **Subject scope: project vs account.** Namespacing to project is the clean isolation
   default (project-per-end-user). Is there a real need for account-level subjects that
   span projects?
2. **Session reuse per subject.** One long-lived session per subject vs a fresh session
   per interaction — affects concurrency-cap math (per-account 5000 ceiling) and warm-pool
   economics.
3. **Metering attribution.** Do we bless `subject_id` as a first-class column on
   `usage_events`/`gateway_request_logs`, or keep reconstructing via `sessionId`↔subject
   in the operator's BFF?
4. **Interaction with the pluggable-runtime-harness work** (`2026-07-08-...`) — backend
   mode's secret-less runtime should compose with, not fork, whatever runtime abstraction
   that spec introduces.
5. **Billing model.** Per-account wallet stays; the operator re-bills. Do we ever want a
   native per-subject sub-wallet, or is BFF-side metering the permanent answer?

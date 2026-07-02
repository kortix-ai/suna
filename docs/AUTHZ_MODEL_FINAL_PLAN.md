# The final, enterprise-ready authorization model — plan

Source: founder notes ("CLEAR ACCESS / AUTHORISATION MODEL IS NEEDED. THAT IS 100% FINAL &
ENTERPRISE READY."). This doc maps every ask to the **current code state** and lays out a
**sequenced, decision-baked plan** to close the gaps. It is for team review before code.

Scope of "the authorization model": Account · Projects (git repo + ops) ·
Agents/Skills/Commands · Connectors · Schedules · Webhooks · GitOps.

Two founder decisions are already baked into this plan:
- **Who approves an ASK-gated action:** project **managers + the launcher**.
- **Unattended (trigger/webhook/cron) run hits an approval gate:** **deny + log (fail safe)** —
  the action is denied and audited, the run continues without it.

---

## 0. Where we are — the foundation is ~85% built

Verified against the code on `feat/iam-rbac-v1` (merged with `main`). Do **not** rebuild these:

| Capability | State | Evidence |
|---|---|---|
| Allow-only, deny-by-default engine (`authorizeV2`) | ✅ | `apps/api/src/iam/engine-v2.ts` |
| Agent-scoped **session token** (agentGrant + serviceAccountId), not user-only | ✅ | `platform/services/session-sandbox.ts` mintExecutorToken; validated `middleware/auth.ts` |
| **kortix.toml `[[agents]]`** = source of truth for agent scope (env/connectors/kortix_cli) | ✅ | `projects/agents.ts` |
| Git auth **never injected** into the sandbox (build-time only) | ✅ | `session-sandbox.ts` resolveGitAuthToken |
| Custom roles + policies, group→role, per-resource grants, revoke immediacy | ✅ | `iam/engine-v2.ts`, `iam/resource-grants.ts`, `iam/cache-invalidation.ts` |
| Standing-identity **service accounts** (agents authorize as their SA once activated) | ✅ (opt-in) | `iam/engine-v2.ts` resolveActorV2; `repositories/service-accounts.ts` |
| Triggers **run as the agent** (human "Runs as" removed) | ✅ | `projects/lib/triggers.ts` resolveTriggerActor |
| **Immediate offboarding** — member removal revokes PATs + live session tokens | ✅ | `repositories/account-tokens.ts` revokeAllAccountTokensForUser |
| APPROVE/ASK/BLOCK **policy resolution** (risk + policies → mode) | ✅ | `executor/*` resolveEffectiveAction |
| **Per-session cost** (LLM + compute) | ✅ | `gateway_request_logs.finalCost`, `sandbox_compute_sessions.costUsd` |
| Snapshot **bake/sync** (baked binaries vs cloned repo/secrets; content-addressed rebuild) | ✅ | `snapshots/builder`, `shared.ts` version pins |
| **SSO + Azure AD SCIM** directory-sync, tested + runbook | ✅ | `iam/sso-sync.ts`, `scim/*`, `docs/ENTRA_SSO_SCIM_SETUP.md` |

The remaining work is the **enforcement/UX loop around** this foundation, plus a few
architectural decoupling epics.

---

## 1. APPROVE / ASK / BLOCK — the resolution loop  *(highest value, partly built)*

**Ask:** "Actually test APPROVE/ASK/BLOCK. What happens? Where do you approve? Who does — the
human that started the task? What about a trigger/webhook? Who sees these?"

**Current state.** Policy **resolution** works: an action resolves to `allow | ask | block` from
its risk + connector/project policies, and the gateway returns `pending_approval` for an ASK.
But the **loop is open**: `executor_executions` has `approvedBy`/`resolvedAt` columns that are
never written; there is **no approval inbox, no approve/deny endpoint, no "who can approve" rule**,
and an unattended run that hits ASK just returns `202 pending_approval` to a webhook with nowhere
to resolve it. The genuinely hard part is **resuming a parked synchronous tool call** after
approval.

**Plan (phased):**

- **1a — Persist + list (S/M).** On an ASK verdict, write a real `pending_approval` row
  (execution id, session, action, risk, args digest, actor). Add
  `GET /v1/projects/:id/approvals?status=pending` (project-scoped inbox) + a per-session view
  (folds into §2 audit).
- **1b — Resolve (M).** `POST /v1/projects/:id/approvals/:executionId/{approve,deny}` →
  set `approvedBy` + `resolvedAt` + status. **Authz gate: the session launcher OR a project
  manager/owner** (decision). New leaf action `project.execution.approve` in `iam/actions.ts`,
  seeded into the manager role + a launcher-self check.
- **1c — Unattended policy (S).** When the session was started by a trigger/webhook/cron (no
  interactive human), an ASK **auto-denies + logs** (decision) — the run continues without the
  gated action; the denial is in the audit log. No hanging sessions, no indefinite blocks.
- **1d — Notify + resume (L, later).** Dashboard badge + Slack notification for pending
  approvals; the sandbox-side resume of the parked tool call (the agent re-invokes the action
  once approved). This is the only epic-sized piece here; 1a–1c deliver a working, safe loop
  without it (attended = approve via inbox before re-run; unattended = deny+log).

**Risk:** additive endpoints; 1d touches the daemon/opencode tool-call path (defer).
**Decisions:** ✅ approvers = managers + launcher; ✅ unattended = deny + log.

---

## 2. Per-session AUDIT LOG + per-agent/actor COST  *(safe, additive — do first)*

**Ask:** "Clear per session AUDIT LOG of everything the agent did" + "Clear per session/agent/user
COST understanding."

**Current state.** All the data exists but isn't surfaced per session/agent:
`executor_executions` (every gated tool/connector call, with risk + status + approval),
`audit_events` (HTTP mutations + IAM), `gateway_request_logs.finalCost`,
`sandbox_compute_sessions.costUsd`. There is **no single per-session audit endpoint** and **no
per-agent/per-actor cost rollup** endpoint.

**Plan:**
- **2a — `GET /v1/projects/:id/sessions/:sessionId/audit` (M).** Chronological timeline of every
  executor-gated action the agent took (action, risk, allow/ask/block verdict, who acted, who
  approved). (Prototyped this pass; reverted to keep the merge PR clean — ship as its own PR with
  route-manifest regen + a ke2e flow.)
- **2b — Cost attribution (M).** `GET /v1/projects/:id/sessions/:sessionId/cost` (already partly
  via gateway/sessions) + per-**agent** and per-**actor** rollups (the columns exist:
  `usage_events.actorUserId`, `gateway_request_logs.actorUserId`, `executor_executions.actingUserId`).
- **2c — Audit webhook/export (S, later).** Extend the existing account audit-webhook to include
  executor executions + session-scoped export for SIEM.

**Risk:** read-only + additive. **Decision needed:** none. **This is the recommended first PR.**

---

## 3. Resource OWNERSHIP + private triggers/webhooks  *(product decision)*

**Ask:** "Introduce PRIVATE triggers/webhooks. Every resource should be scoped to ownership.
Remove the concept of everyone brings their own to profile."

**Current state.** Triggers/webhooks are **project-wide visible** to anyone with `project.read`;
`project_trigger_runtime.ownerUserId` was only ever credential-resolution metadata (now removed)
— there is **no ownership access-control**. Connectors + secrets *do* have an ownership/grant
model (share-scope + grants); triggers/skills/commands do not.

**Plan:**
- **3a — Ownership as a first-class per-resource dimension (M/L).** Reuse `iam_resource_grants`
  (already keys agents/skills) to add trigger/webhook resource types, or add an `owner`/`visibility`
  column to the trigger runtime and gate `loadTriggersForResponse` + the fire endpoints on it.
  Default: creator-owned + optionally shared, mirroring secrets/connectors — "private by default,
  share explicitly."
- **3b — Remove per-user connector profiles (M, BREAKING).** "Everyone brings their own to
  profile" = `executor_connectors.credentialMode='per_user'` + `resolveCredentialValue` by userId.
  Removing it means connectors are **shared/agent-owned only**. This is a breaking change
  (connector lifecycle, the credential-mode UI toggle, existing per-user credential rows) and
  needs a **migration + founder sign-off** on the replacement (agent-owned credentials).

**Risk:** 3b is breaking + touches live data. **Decision needed:** confirm the ownership model
shape (reuse resource-grants vs new column) and greenlight the per-user removal + migration.

---

## 4. Fully AGENT-based authorization (never user-based within a session)  *(epic)*

**Ask:** "Make everything Agent-based authorization, never user-based within session." +
"kortix.toml as source of truth, everything defined explicitly."

**Current state.** Standing identity is **opt-in**: an agent session authorizes as its service
account only once an admin assigns that SA a role; otherwise it **falls back to the launching
human** (`user role ∩ agent grant`). Inside a session, secrets + connector credentials still
resolve as the **launcher's** share-subject, not the agent's. And `[[agents]].env` defaults to
`'all'` when omitted (back-compat), so scope isn't fully explicit.

**Plan (epic, security-sensitive — phase carefully):**
- **4a** Auto-provision + **auto-activate** every agent SA at session mint with a **deny-by-default
  baseline role** derived from its `[[agents]]` scope — so agents are agent-identity by default,
  not on an admin toggle.
- **4b** Resolve secrets + connectors **as the agent SA** inside the session (not the launcher).
  Reuses the inheritance engine (`agent-inheritance.ts` already resolves an agent's declared
  resources) — flip the session-env builder to key on the agent, not `input.userId`.
- **4c** Make `[[agents]].env` **explicit / deny-by-default** (drop the `'all'` fallback) behind a
  project flag, with a migration path so existing agents don't lose access silently.

**Risk:** high — changes what every session can access; must not break existing projects.
**Decision needed:** opt-out (default agent-identity) vs keep opt-in; the `env` default flip.

---

## 5. Token consolidation ("too many tokens")  *(cleanup + epic)*

**Ask:** "Big tokens mess, too many tokens & api keys. Figure out a diff way. Agent-tokens that
give access to the appropriate allowed Kortix scopes."

**Current state.** The session token is already agent-scoped (§0). Remaining sprawl is mostly
**legacy aliases** injected for back-compat: `KORTIX_TOKEN` (alias of `KORTIX_SANDBOX_TOKEN`),
`KORTIX_EXECUTOR_TOKEN` (alias of `KORTIX_CLI_TOKEN`), `KORTIX_YOLO_*` (redundant with
`KORTIX_LLM_*`). The deeper "one token, resolve all downstream creds (connectors/secrets/git)
server-side at call time, inject nothing" is architectural.

**Plan:**
- **5a — Drop legacy aliases (S, coordinated).** Remove `KORTIX_TOKEN`/`KORTIX_EXECUTOR_TOKEN`/
  `KORTIX_YOLO_*` **after the sandbox image cycles** (daemons currently read them) — this is the
  documented "Phase 2" in `docs/specs/2026-06-28-token-session-agent-identity.md`. Must not be
  done standalone (would break running daemons).
- **5b — Server-side credential resolution (L).** Stop injecting project runtime secrets at boot;
  have the executor resolve connectors/secrets/git per-call against the session token's scope, so
  the sandbox holds exactly one opaque, agent-scoped token and no raw credentials. Big, but it's
  the real "clean token model."

**Risk:** 5a needs image-cycle coordination; 5b is architectural. **Decision needed:** timing of 5a.

---

## 6. Harnesses (Codex/Claude/Eve) + server-side skills  *(epic)*

**Ask:** "Want Codex/Claude SUPPORT (besides Opencode) — how do we load all these as harnesses?" +
"Skills we can move server-side for discovery (perplexity computer style) for authorization
control (need to modify opencode?)."

**Current state.** The CLI scaffolds multi-harness symlinks (`.claude`/`.codex`/`.agents` →
`.kortix/opencode`), but the **session runtime is hardcoded to opencode** (`createOpencodeSupervisor`
always spawns `opencode serve`; token mint assumes an opencode "executor session"). Skills are
**file-based** (cloned at boot, discovered for IAM grants at build time) — no server-side skill
discovery API.

**Plan (epic):**
- **6a** Abstract the harness spawn into a pluggable interface (spawn cmd, config injection,
  identity, token shape) with opencode as the first implementation; add Codex/Claude adapters.
- **6b** Server-side skill discovery: a `/skills` API the harness pulls at runtime (needs an
  opencode modification), enabling per-request authorization control over which skills load.

**Risk:** large; touches the runtime + a fork of opencode. **Decision needed:** priority + which
harness first.

---

## 7. Agnostic backend / "CMS" + SDK completeness  *(partly now, mostly epic)*

**Ask:** "Design Kortix so it can 100% be used as a wrapper backend API. Make everything agnostic,
think of it as a CMS. The git/company-specific stuff kinda fucks it up." + "Web & Mobile both use
the SDK; clean elegant API top to bottom."

**Current state.** The **SDK is already the single client** for the core control plane
(projects/sessions/secrets/access/runtime), and the facade is clean. Gaps: web still bypasses the
SDK for ~58 non-core endpoints (admin console, billing, gateway observability, marketplace admin);
the SDK lacks full workspace file-I/O CRUD + some hooks; and **git is a hard dependency**
(`repo_url`/`default_branch`/`manifest_path` required; GitHub-specific functions in the core SDK).

**Plan:**
- **7a — SDK coverage (M, incremental).** Wrap the remaining endpoints + file-I/O CRUD + missing
  hooks so web/mobile never bypass the SDK. Safe, incremental.
- **7b — Git-optional / CMS mode (L).** Make `repo_url`/`branch`/`manifest_path` optional (backend
  detects "no-git" mode); move GitHub-specific SDK functions out of the core; treat the project
  config as content that can come from git **or** the API. This is what unlocks "wrap Kortix as a
  generic backend."

**Risk:** 7b is architectural. **Decision needed:** commit to git-optional as a first-class mode.

---

## Recommended sequence

1. **Merge PR #4039 now** — it's the green, tested authz foundation (§0).
2. **PR A (safe, next):** §2 per-session audit log + cost attribution.
3. **PR B:** §1a–1c approve/ask/block loop (decisions baked; defer 1d resume).
4. **PR C:** §3a resource ownership / private triggers.
5. **Founder-gated:** §3b remove per-user connectors (migration), §4 full agent-identity,
   §5 token consolidation, §6 harnesses, §7b CMS decoupling — each its own planned PR.

Everything above §3b is additive/safe and can ship without breaking existing projects. Everything
from §3b down changes existing behavior and needs an explicit greenlight + migration.

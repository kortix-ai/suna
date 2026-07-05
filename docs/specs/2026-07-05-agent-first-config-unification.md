# Agent-First Configuration & Authorization Unification

**Status:** Draft for review — Marko + Fable, 2026-07-05
**Depends on:** IAM/RBAC v1 (shipped, `feat/iam-rbac-v1`), `docs/AUTHZ_MODEL_FINAL_PLAN.md`, `docs/specs/2026-06-28-token-session-agent-identity.md`
**Supersedes in part:** `docs/specs/2026-06-28-project-authorization-runtime-governance.md` (the config-compilation direction; the ACL model it sketched was replaced by IAM v1)

---

## 0. The one-sentence thesis

**The agent is the unit of identity, authorization, and configuration.** Everything a
project can do is declared on an agent in one manifest; humans get access *through*
agents (the pyramid); the platform compiles that declaration into whatever runtime
executes it (OpenCode today; Codex/Claude later). Every concern in this spec is a
consequence of taking that sentence seriously.

## 1. Where we actually are (verified 2026-07-05)

Facts established by direct code inspection — each of these shapes a decision below:

1. **`[[agents]]` is a governance overlay, not an agent definition.** It carries
   `connectors`/`kortix_cli`/`env` grants. All *behavior* (prompt, mode, tools,
   permission tree, temperature, steps…) lives in hand-authored
   `.kortix/opencode/agents/*.md` files that Kortix passes through blind.
2. **Two `[[agents]]` fields are dead**: `model` parses and round-trips but never
   reaches the running OpenCode process (effective model comes from
   `KORTIX_OPENCODE_MODEL` ← session/model-preferences DB); `file` is carried but
   unused in materialization.
3. **Agents are optional, and absence means unrestricted.** No `[[agents]]` → grant
   resolves to `null` → session capped only by the launching human's role. Once a
   project adopts `[[agents]]`, unlisted agents are default-denied. This
   adopt-to-govern posture is deliberate back-compat.
4. **YAML already works.** `packages/manifest-schema/src/format.ts` is dual-format;
   `kortix.yaml` is *preferred* over `kortix.toml` in candidate-path resolution.
   Blockers are narrow: `apps/cli/src/manifest-edit.ts` (comment-preserving TOML
   text surgery) guard-throws on YAML projects, and
   `POST /projects/:id/manifest/validate` assumes TOML.
5. **`[[channels]]` is validated but dead at runtime.** The live channel→agent
   mapping is the `chat_channel_bindings` DB table, manageable only from inside
   Slack; no web UI exists.
6. **There are two unrelated trigger systems.** The git `[[triggers]]` manifest is
   what the scheduler fires (agent-first, correct); the web "Triggers" UI talks to
   the in-sandbox daemon's ephemeral `/kortix/triggers` endpoint and never touches
   the manifest.
7. **Trigger identity is agent-first with two seams**: (a) a trigger with no
   `agent` in an ungoverned project resolves to full owner-equivalent access;
   (b) run attribution (`created_by`, billing, audit) is "an arbitrary account
   owner," not the agent's service account (tracked TODO in `triggers.ts`).
8. **Secrets are single-valued.** One shared value per (project, name);
   `agent_scope` only narrows *who may see that one value*. No display name — the
   name *is* the env key. Same-key-different-value-per-agent does not exist.
9. **Connector "profile" is informal.** It means "one `executor_connectors` row."
   Unscoped (`agent_scope` empty) = usable by ALL agents; same two-axis model as
   secrets (agent-side self-narrow ∩ resource-side gate). `per_user` credential
   mode composes with, and is orthogonal to, agent scoping — and it resolves the
   *launching human's* credential, which is the main obstacle to fully
   agent-based sessions (AUTHZ plan §3b/§4b).
10. **CLI permissions and connector policies are different systems for good
    reason.** `kortix_cli` grants are role-anchored (`userRole ∩ agentGrant` — the
    agent can never exceed its launching human); the executor policy engine is
    risk-tiered per-call approval for discovered external actions. Folding CLI
    into connectors would forfeit the role ceiling. What CLI *lacks* is the
    approval tier: `project.gitops.merge` and `project.deploy` are pure
    allow/deny today.
11. **The Members-page grant flow is already agent-only** (picker hardcoded to
    agents; pyramid comment in code), but the backend still accepts
    `skill`-type grants via raw API and secrets live in a separate share model.
12. **Enterprise gating asymmetry**: SSO/SCIM are visually gated on entitlement;
    Groups/Roles/Policies were functionally gated (402) but visually open —
    fixed in the IAM-finalisation branch this spec ships with.
13. **Known limitation carried forward**: the sandbox git-clone boundary
    (`authorizeGitProxy` ignores scope) — deferred 2026-07-05, documented in
    `IAM_RBAC_V1_PLAN.md`. This spec's Phase 4 is where it gets closed.

## 2. Target model

### 2.1 The manifest is the agent registry — and agents become mandatory

- `kortix.yaml` becomes the canonical manifest (see §2.7 for the TOML story).
- Every project **must declare its agents** in the manifest. Enforcement:
  - New projects: the starter template ships with agents declared and
    `agents.required = true` implied by `kortix_version: 2`. Creation flows
    (starter, `kortix init`) always scaffold at least one agent.
  - Existing projects: a platform flag (`KORTIX_REQUIRE_DECLARED_AGENTS`,
    default **on for new projects, off for pre-existing**) controls whether an
    undeclared agent name may boot a session. Pre-existing projects keep the
    v1 adopt-to-govern behavior until migrated (§2.8).
  - End state: the `null`-grant ("no agents declared → unrestricted") path is
    deleted once migration completes. Unrestricted becomes impossible to express.
- The `default` sentinel survives only as "the manifest's `default_agent`" — it
  must always resolve to a *declared* agent under v2. A trigger or channel that
  names no agent gets the project default agent, never owner-equivalent power.
  This closes trigger seam 7(a) structurally rather than with a patch.

### 2.2 One agent, two files, one home each (redirected 2026-07-05)

> **Decision 2026-07-05 (Marko):** the design below (a nested `opencode:`
> sub-object inside the manifest's agent block, with an "illegal frontmatter"
> gate on the `.md`) shipped first, then was killed the same day for hedging
> between two homes for one concern. **The replacement, in one sentence:
> OpenCode behavior lives in the native `.md` (frontmatter + body); Kortix
> governance lives in `kortix.yaml`. One home per concern.** Everything below
> describes the *current*, redirected model. The nested-`opencode:`-block /
> illegal-frontmatter design is dead — do not resurrect it.

The v2 agent entry does NOT unify `[[agents]]` (TOML) and
`.kortix/opencode/agents/*.md` into one manifest-side bag of fields. Instead
it leaves behavior exactly where OpenCode itself already expects it — the
agent's own `.md` frontmatter + body, a stock OpenCode agent file with no
Kortix-specific split — and narrows the manifest's `agents:` map down to pure
governance:

```yaml
kortix_version: 2
default_agent: support

agents:
  support:
    enabled: true                       # default true; false = can't start sessions
    connectors: [github, slack]         # profile slugs | all | none
    secrets: [STRIPE_KEY, GH_TOKEN]     # renamed from `env`; names | all | none
    skills: [pdf-export]                # project skill names | all | none
    kortix_cli: [project.session.start, project.cr.open]
    workspace: runtime                  # runtime | read | branch  (Phase 4, git boundary)
  pr-bot:
    connectors: [github]
    kortix_cli: [project.cr.open, project.cr.merge, project.review.submit]
```

That's the WHOLE agent block — no `description`, no `model`, no `opencode:`
sub-object, no `mode`/`temperature`/`permission`/`prompt`. Every one of those
now lives in the matching `.kortix/opencode/agents/<name>.md`:

```markdown
---
description: "Handles customer support triage"   # required for subagents
model: anthropic/claude-sonnet-5                  # declarative default; DB prefs override at runtime
mode: primary                                     # primary | subagent | all
temperature: 0.2
steps: 200
color: "#7C5CFF"
hidden: false
permission:                                       # full OpenCode PermissionConfig tree, passed through
  edit: ask
  bash: { "git push": deny, "*": allow }
  webfetch: allow
---

You triage customer support tickets with empathy and precision.
```

Rules:

- **The agent's NAME is the join** between the manifest's `agents:` map key
  and the `.md` filename: `agents.<name>` ↔
  `.kortix/opencode/agents/<name>.md` (path derived from the project's
  top-level `[opencode] config_dir`, default `.kortix/opencode` — unrelated to
  the old per-agent nesting, this is the same project-wide setting v1 always
  had). No manifest field ever spells this path out.
- **`model` and `description` moved OFF the Kortix layer** — both are native
  OpenCode `AgentConfig` fields (the gateway/session pipeline still resolves
  `model` the same way; `description` is what OpenCode itself uses for
  subagent-selection hints), so both live in the `.md` now, not in
  `kortix.yaml`. `enabled` stays the one Kortix-governance field with no
  OpenCode equivalent — "can this agent even start a session," a
  platform-level gate, orthogonal to whatever the `.md`'s own native
  `disable` field (if hand-authored) says.
- **Frontmatter is EXPECTED, never illegal.** A stock OpenCode agent `.md` —
  including ones with rich frontmatter nobody wrote with Kortix in mind — is
  valid v2 input as-is. The "illegal frontmatter" gate and the nested
  `opencode:` manifest sub-object are both **removed outright**, not renamed
  again. Authoring any behavioral field (`description`/`model`/`mode`/
  `temperature`/`top_p`/`steps`/`variant`/`color`/`hidden`/`permission`/
  `prompt`, or a nested `opencode:` block) on the manifest agent block is a
  hard validation error pointing at the `.md` instead.
- **`secrets` replaces `env`** as the grant-set name (accurate: they're project
  secrets, not arbitrary env). v2 default when omitted: **`none`** — v2 is
  deny-by-default across all three grant sets, killing the `env: 'all'`
  back-compat special case. (Migration writes an explicit `secrets: all` into
  converted manifests so nothing silently breaks — the default changes, not the
  migrated behavior.)
- **`skills` is the one governance field with a runtime representation**: the
  compiler folds it into the compiled agent's `permission.skill` — users never
  author `permission.skill` directly when using the governance grant, and this
  fold is the reason the compiler still exists even though behavior no longer
  needs "compiling" out of the manifest.
- **No precedence to document.** The pre-redirect design needed a rule for
  "manifest `opencode:` block vs. `.md` frontmatter, which wins" — that
  question is now moot because behavior only ever lives in one place. The
  only overlay left is governance-onto-behavior: `enabled: false` always
  forces the compiled `disable: true` (platform gate wins); `skills` always
  owns the compiled `permission.skill` key.
- **Runtime attribution**: every session/trigger run is attributed to the agent's
  service account (auto-provisioned per agent, already exists as
  `ensureAgentServiceAccount`), closing trigger seam 7(b). The human launcher
  remains recorded as the *initiator* — attribution and authorization stop
  sharing one field.

### 2.3 Runtime-agnostic by construction: the compiler

```
kortix.yaml (governance) ─┐
                          ├─► runtime compiler ──► OpenCode config
.md frontmatter+body ─────┘   (per runtime:       (agent map + permission
 (OpenCode behavior)            opencode | codex    + mcp + model overlays,
                                 | claude — later)   written by the daemon)
```

- New field: `runtime: opencode` (project-level, default `opencode`, the only
  accepted value for now). The schema reserves the enum; the compiler interface
  (`compileAgentConfig(manifest, runtime, agentMdFiles) → runtime-native
  config`) is what makes a future `runtime: claude` a one-line project change
  instead of a migration.
- **What moved with the redirect:** the compiler's INPUT source for behavior
  moved from a manifest `opencode:` sub-block to each agent's native `.md`
  frontmatter (read straight from git, same as the manifest itself); its
  OUTPUT shape (the compiled `OpencodeAgentConfig`/`OpencodeConfig` the daemon
  consumes) is byte-for-byte unchanged — every behavioral field still maps
  1:1, `skills` still folds onto `permission.skill`, the top-level `model`
  passthrough still mirrors the `default_agent`'s resolved model. Only where
  the compiler reads FROM changed, not what it produces.
- Implementation home: extend the existing merge point —
  `buildOpencodeConfigContent()` in `apps/kortix-sandbox-agent-server` already
  overlays MCP/provider/permission onto the repo's config. The compiler moves
  that composition server-side (apps/api) so the sandbox receives a **sealed,
  already-compiled config** rather than composing trust-relevant config inside
  the sandbox. The daemon keeps only session-local overlays (Slack
  `question: deny`).
- This revives the "runtime generated from policy" idea from the 2026-06-28
  governance spec in a narrower, buildable form: we compile *agent config*, not
  the whole workspace materialization (that's Phase 4).
- Kills dead fields as a side effect: `[[agents]].model` becomes live (compiled
  into the agent map from the `.md`'s own `model:` frontmatter field, still
  overridable by DB model-preferences at the session/trigger layer —
  precedence: explicit session > trigger > DB prefs > compiled agent config >
  account > platform).

### 2.4 Secrets v2: named secrets with per-agent values

Today's model (one value per key, allowlist scoping) can't express "same
`STRIPE_KEY`, test value for the support agent, live value for the billing
agent." Target:

- **Secret = display name + env key + one or more values.** Schema: keep
  `project_secrets` as the secret identity row (add `display_name varchar(120)`),
  add `project_secret_values (secret_id, agent_scope text[] | NULL, value_enc, …)`
  with `NULL` scope = the default value. Resolution at sandbox boot: most
  specific value wins (agent-scoped > default); ambiguity (two values matching
  one agent) is a validation error at write time, not boot time.
- Existing `agent_scope` on the secret row is reinterpreted as it is today
  (visibility narrowing) and continues to compose: first "may this agent see
  this secret at all," then "which value does it get."
- UI: secrets manager gets display name + a per-value "applies to" agent picker.
  CLI: `kortix secrets set STRIPE_KEY --agent billing`.
- **Starter hygiene** (do immediately, independent of the rest):
  remove `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from `[env] optional` in
  `kortix.toml`, `packages/starter/templates/base/kortix.toml`, and the doc
  prose that showcases them. They confuse BYOK with platform credentials; the
  platform already hard-forbids its own keys of those names from sandboxes.

### 2.5 Connector profiles, channels, and the meaning of "ALL"

- **Formalize the profile.** "Connector profile" = named `executor_connectors`
  row (slug + display name + provider + credential mode + policies + agent
  scope). No new entity needed — the spec's contribution is making the term
  precise and using it consistently in UI/docs/CLI.
- **ALL semantics, stated once and enforced twice:** a profile with empty
  `agent_scope` is usable by **all declared agents**; a profile with a scope is
  usable only by those agents. Symmetrically, an agent's `connectors: all` means
  "all profiles not scoped away from me." Effective access is always the
  intersection (agent-side self-narrow ∩ profile-side gate) — this is already
  how `connectorUsable` + `agentMayUseConnector` behave; v2 documents it and the
  UI displays the *effective* matrix (per agent: which profiles, and why).
- **Under v2's deny-by-default**, `connectors: none` (the omitted default) means
  a new agent sees nothing until granted — "ALL" stops being an accident of
  omission and becomes an explicit choice on either side.
- **Channels become manageable**: a web Channels surface listing
  `chat_channel_bindings` (workspace, channel, bound agent, model override,
  conversation policy) with edit = the same `setChannelAgent`/`setChannelModel`
  the Slack commands use. The dead `[[channels]]` manifest block is **removed
  from the schema** (v2) rather than wired up: channel↔agent routing is live
  operational state (like OAuth installs), not declarative config — same
  boundary rule that keeps credentials out of git. The channel *integration*
  itself remains a connector profile (`provider: channel`), which is the
  declarative part.
- **`per_user` credential mode is removed now, and redesigned later as an
  explicit "connect your own account" feature** (decided 2026-07-05, after prod
  sizing: 248 per_user connectors across 138 accounts but only **69** stored
  per-member credential rows; shared already dominates Pipedream 592 vs 247).

  *Why the concept is real (the driving use case):* a single shared agent
  definition — e.g. a sales-outreach agent needing LinkedIn/email/X — that must
  act as **whichever team member is running it**, so you don't duplicate the
  agent once per employee. That is legitimate and important. But it is
  fundamentally *delegated identity*: "resolve credentials as the human who
  launched this session." It has a coherent answer only for **interactive,
  human-in-the-loop** sessions. The same agent on a **trigger or channel** (no
  human) has no answer to "whose account?" — there it must use an agent-owned
  (shared) credential. Today's `per_user` conflates these, is the ambient
  default for all of Pipedream, and leaks launcher identity into the credential
  path for every session type, which is the specific coupling blocking clean
  agent-first identity.

  *What ships now (removal):* Pipedream's default flips to `shared`; existing
  per_user connectors flip to `shared` with **no silent credential promotion**
  — a per-member OAuth is a personal identity, so affected connectors clear
  their credential and surface "reconnect required" for someone with
  connector-write authority; the per-member credential rows are deleted by the
  migration. Affected accounts get comms before the carrying release.

  *What comes back later (the redesign, tracked, not built now):* a deliberate
  **per-member connected-accounts** feature — each member links their own
  LinkedIn/email/X to a shared agent, scoped to **interactive sessions only**,
  with autonomous runs of the same agent falling back to an agent-owned
  credential or being explicitly disallowed. The sales-outreach scenario above
  is the acceptance test for that feature.

### 2.6 Kortix CLI permissions: role-anchored, approval-capable

Decision: **do not fold `kortix_cli` into connector profiles.** The role ceiling
(`userRole ∩ agentGrant`) is the system's core invariant and lives in the IAM
engine; connectors' access model has no role awareness, and faking it inside the
executor gateway would duplicate the engine. What we take from the executor
instead is its approval UX:

- Add an optional risk tier to CLI leaf actions: `project.gitops.merge`,
  `project.deploy`, `project.members.manage` (initial set) can be marked
  `require_approval` per project (manifest: `approvals.kortix_cli: [project.gitops.merge]`).
  Enforcement reuses `sessionToolApprovals` + the Review Center / Slack card
  machinery the executor already has — additive layer *after* the allow/deny
  gate, never a substitute for it.
- Prerequisite (found during research, cheap to do first): an **enforcement
  audit** proving every grantable `PROJECT_ACTIONS` leaf is actually asserted on
  a route with the token threaded (`project.gateway.*`, `project.webhook.*`,
  `project.schedule.*` unverified today).

### 2.7 TOML → YAML

- v2 manifests are YAML (`kortix.yaml`). TOML remains fully supported **for v1
  manifests only** — `kortix_version: 2` in a `.toml` file is a validation error
  pointing at the migration command. This gives TOML a clean sunset without a
  hard break: v1 projects keep working untouched.
- Work items (small, verified): make `manifest-edit.ts` format-aware (or switch
  CLI edits to `serializeManifestObject` for YAML, where comment preservation is
  a native YAML-lib feature), pass `format` into the `/manifest/validate`
  endpoint (derive from `manifestPath`), fix the two cosmetic
  `MANIFEST_FILENAME` constants in error strings, and add the missing
  `[[agents]]`/`[[channels]]`→`agents:` sections to `manifest.mdx`.
- Why YAML at all: the v2 agent block (nested permission trees, per-value secret
  scoping, approval lists) is genuinely awkward in TOML; YAML also matches the
  OpenCode/Claude/Codex config ecosystems users already know.

### 2.8 Migrating existing projects

- `kortix migrate` (CLI) + a one-click dashboard banner, both driving the same
  server-side transform: read v1 TOML's `[[agents]]` governance → emit
  `kortix.yaml` (v2) with an equivalent `agents:` map, `env` renamed `secrets`
  (written explicitly as `all` where v1 defaulted), `[[channels]]` dropped —
  delivered as a **change request** on the project repo, reviewed and merged
  like any other change. Nothing migrates silently. **Redirected 2026-07-05:**
  no `.md` frontmatter is touched at all — v1's frontmatter is already valid
  v2 OpenCode behavior (nothing to hoist), which is what makes this a
  governance-only, comparatively small migration.
- The platform reads both versions indefinitely (validator already
  version-gates); the *feature* incentive to migrate is that everything in this
  spec (per-agent model/permissions, secret values, approvals) is v2-only.
- Rollout order: starter template + new projects first (v2 native), migration
  tooling second, nag banner third, v1-write-path freeze (API manifest CRUD
  refuses to *add new* sections to v1 manifests) last.

### 2.9 The permission map — one mental model

The complexity Marko flagged collapses under one rule:

> **Every capability is either a git write (goes through a change request) or a
> platform action (goes through an IAM leaf). Nothing is both.**

| Capability | Class | Gated by |
|---|---|---|
| Edit agents, skills, commands, manifest, memory | git write | `project.gitops.push` / CR review; agent needs `workspace`/`git` powers (Phase 4) |
| Merge a change request | platform action on git | `project.cr.merge` (+ optional approval tier) |
| CRUD connectors, secrets, channels bindings, model prefs | platform action | `project.connector.write`, `project.secret.write`, … |
| Fire/create triggers & webhooks | split: definition is git write, firing is platform | definition via CR; `project.trigger.fire` for manual fires |
| Start/stop sessions, deploy | platform action | `project.session.*`, `project.deploy` |
| Member/group/role admin | platform action (account/project) | IAM roles + Enterprise entitlement for custom RBAC |

- "Can he edit the agent's skills?" = "can he land a CR touching `.kortix/`" —
  one question, not two systems. The *session* path to the same edit (ask an
  agent to edit the repo) goes through the **same** gate because the agent's
  write lands as a CR under the agent's `kortix_cli`/workspace powers.
- Auto-clone on project creation, "can he clone at all," and per-agent repo
  visibility are all the **Phase 4 git boundary** (workspace/git powers stamped
  into the session token; `authorizeGitProxy` honoring them) — the one
  already-documented deferral. This spec sequences it, it does not re-defer it.
- Member-facing resource scoping stays **agent-only** (the pyramid): you assign
  people to agents; agents carry the resources. Backend follow-through: stop
  accepting new `skill`-type rows in `iam_resource_grants` POST (UI already
  can't create them), keep legacy rows readable/revocable.

## 3. Phased plan

Each phase is independently shippable; order minimizes rework.

| Phase | Scope | Size |
|---|---|---|
| **0. Hygiene** (now, with IAM finalisation) | Starter key examples removed; Members copy fix; Groups/Roles visual gating; manifest.mdx agents/channels docs; CLI-leaf enforcement audit | S |
| **1. Schema v2 + compiler skeleton** | `kortix_version: 2` YAML schema (governance-only agent block, `secrets` rename, deny-by-default, `runtime` enum, `[[channels]]` removal); server-side `compileAgentConfig` for opencode reading behavior from each agent's native `.md` frontmatter (redirected 2026-07-05 — no illegal-frontmatter gate, no nested `opencode:` block); dead-field removal; `manifest-edit`/validate-endpoint format fixes | L |
| **2. Mandatory agents + trigger identity** | `KORTIX_REQUIRE_DECLARED_AGENTS` flag (on for new projects); default-sentinel-must-resolve rule; trigger/channel sessions attributed to agent SA; web Channels management surface | M |
| **3. Secrets v2 + approvals + per_user removal** | display name + per-agent values (schema + resolution + UI/CLI); CLI-action approval tier via Review Center (default set: `project.gitops.merge`); remove `per_user` credential mode per §2.5 (migration + reconnect-required UX + account comms) | L |
| **4. Git boundary** | `workspace`/`git` powers per agent; resource caps stamped into session token; `authorizeGitProxy` enforces; auto-clone policy per agent | L |
| **5. Migration & sunset** | `kortix migrate` CR generator; dashboard banner; v1 write-freeze; eventually flip remaining projects | M |

Phase 0 ships in the IAM-finalisation PR this spec accompanies. Phases 1–2 are
the "agent-first identity is real everywhere" milestone; 3–5 are quality and
consolidation.

## 4. Decisions (resolved 2026-07-05 unless noted)

1. **`per_user` connector credentials**: **REMOVE now, REDESIGN later** —
   confirmed 2026-07-05. Prod sizing (69 credential rows, 138 accounts, shared
   already dominant) makes the migration tractable. The delegated-identity use
   case (one shared agent acting as each member — e.g. sales outreach) is real
   and becomes the spec for a future explicit "connect your own account"
   feature scoped to interactive sessions; it is NOT preserved by keeping
   today's launcher-coupled ambient default. Removal + safe migration lands in
   Phase 3; the redesign is tracked separately.
2. **Approval-tier default set**: `project.gitops.merge` only in new projects.
3. **v2 deny-by-default for `secrets`**: confirmed. Migration writes explicit
   `all` into converted manifests; only newly declared v2 agents feel it.
4. **Timing of Phase 4** relative to bringing Codex/Claude runtimes — still
   open; the compiler (Phase 1) is the prerequisite for both; they can proceed
   in parallel after it.

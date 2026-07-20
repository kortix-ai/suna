# Kortix as a Backend (KaaB) v1 — Subjects, Releases, State Overlay & the Credential Broker

Status: Draft RFC for review · 2026-07-21

## 0. TL;DR

**The ask:** Let a third party wrap Kortix as a pure backend — e.g. a consumer AI app with 100k end-users all driving **one shared agent in one repo**, where every end-user brings **their own** connections (their Gmail, their Notion), their own files/memory, and their own metered costs — without those users being Kortix members, and **without trusting them with anything inside the sandbox**.

**The reality (verified):** the current architecture assumes the opposite on three axes:

1. **Trusted principal** — `runtime` secrets are pushed into the sandbox as env at boot and on hot-push ([sandbox-env-sync.ts](../apps/api/src/projects/lib/sandbox-env-sync.ts)). Any principal who can make the agent run code (or just prompt it) can exfiltrate them. Acceptable for members; disqualifying for third-party end-users.
2. **Repo as the universe** — code *and* state (workspace files, memory, brain) live in one working tree, cloned per session. There is nowhere for per-end-user state to live, and clone-per-session is the wrong boot path for an API product.
3. **Agent-bound credentials** — one connector profile per agent. Per-user connector credentials *existed and were removed on 2026-07-05* ("every connector resolves the one shared credential regardless of owner" — [kortix.ts:733–735](../packages/db/src/schema/kortix.ts)). The need was real; the layer was wrong.

**The unlock (verified — this is activate + extend, not greenfield):**

- **The credential broker already exists.** `project_secret_scope = 'connector'` secrets are "resolved **SERVER-SIDE by the gateway** and **NEVER injected into the sandbox**" ([kortix.ts:427](../packages/db/src/schema/kortix.ts)). The pattern KaaB needs is live today for executor connectors — it just resolves one shared credential instead of a per-principal one.
- **Principal-shaped connector grants already exist** — `executor_connectors` / `executor_connector_grants` carry member|group allow-lists ([kortix.ts:411](../packages/db/src/schema/kortix.ts)). Extending the principal set is a schema evolution, not a new concept.
- **Public pre-authorized credential capture already exists** — `/v1/setup-links/{secret,connector}/:token` ([index.ts:798](../apps/api/src/index.ts)) is exactly the primitive a hosted "connect your Gmail" flow for end-users needs.
- **Per-session metering already exists** — `usage_events` with per-session attribution ([kortix.ts:1553, 1822](../packages/db/src/schema/kortix.ts)); adding a subject dimension is one nullable column.
- **Token infra already exists** — hash-stored bearer tokens with status/revocation (PATs, SCIM tokens, sandbox session tokens; pattern in [repositories/scim.ts](../apps/api/src/repositories/scim.ts)). A subject session token is one more audience.
- **Release infra already exists** — snapshots + warm pool ([snapshots/templates.ts](../apps/api/src/snapshots/templates.ts)) already bake and boot prepared images.

**Strategy:** introduce **`subject`** — an external end-user principal with no IAM seat — and make today's internal mode the *permissive special case* of one general model. **Not a toggle**: a toggle forks the product into two modes that rot independently; instead, every session runs as a principal inside a policy envelope, and a member is simply a principal whose envelope is permissive. Four decouplings carry the whole design (§2). Each phase ships independently; **Phase 1 alone makes "wrap a base chat agent" sellable**.

---

## 1. Problem statement

The wrapper scenario: a company builds a consumer product on top of Kortix. They deploy **one agent** (one repo: prompts, skills, executors). Their backend authenticates **their** users and calls Kortix server-to-server. Requirements:

| Requirement | Today | Why it fails |
| --- | --- | --- |
| 100k users share 1 agent, each with their own Gmail/Notion | One connector credential per connector, agent/project-wide | Users would share one Gmail — absurd — or need 100k agent copies |
| End-users must never see operator or other-user credentials | `runtime` secrets land in sandbox env | Prompt injection or a plain "print your env" exfiltrates them |
| Per-user files/memory that persist across sessions | State lives in the repo working tree | Per-user writes would pollute the shared repo or vanish |
| Per-user cost attribution + caps | Account-level billing; per-session usage rows | No end-user identity to attribute to |
| Fast, cheap session boot at API scale | Git clone per session | Clone of a shared, unchanging program 100k× is waste |
| End-users are not Kortix members | Principals are account members (IAM seats) | Seats, invites, and login flows make no sense for `user-123` |

The wrapper can build its own proxy that mints tokens and attributes costs — but it **cannot** work around agent-bound connector profiles, repo-bound state, or secrets-in-sandbox. Those are ours to fix.

**Why not a mode toggle:** a "backend mode" flag creates two products in one codebase — every feature decision forks, and the untrusted path becomes the untested path. The safer architecture makes untrusted the *general* case and trusted the *policy exception*, so one code path is exercised by both.

## 2. Design thesis — four decouplings

**D1. Identity: `principal = member | group | subject`.**
A **subject** is an external end-user identity owned by the wrapper: a row keyed by the wrapper's `external_id`, no `auth.users` row, no seat, no sign-in. The wrapper's backend mints **scoped subject session tokens** server-to-server. A member is a principal with a permissive envelope; a subject is a principal with a restrictive one. One engine.

**D2. Code vs. state: the repo is the program; state lives in a per-principal overlay.**
A **release** = `repo@commit` baked into a snapshot (existing template infra). Subject sessions boot a release: `/repo` is read-only, there is no clone and no git credential in the sandbox. Beside it, `/workspace` is the session's **state overlay**: for a *member* session the overlay **is** the repo working tree (today's behavior, byte-identical); for a *subject* session it is that subject's persistent storage prefix (files, memory, artifacts — quota'd, lazily created). One session pipeline; the mount policy differs.
This is the direct answer to *"how, if everything is stored in a repo?"* — for subjects, it isn't. The repo is the app, not the database.

**D3. Credentials: requirement ≠ profile ≠ execution.**
- The **requirement** ("this agent uses gmail") stays in the manifest. It is code; it belongs to the repo.
- The **profile** (whose Gmail) becomes a `connections` row keyed by **principal** — the 2026-07-05 removal re-landed at the correct layer.
- The **execution** happens at the **broker**: the sandbox emits "invoke `gmail.search` as my principal" carrying only its session token; the gateway resolves the caller's connection, attaches the credential server-side, executes, and returns the result. The `'connector'` secret scope already works exactly this way — we generalize *which credential* it resolves, per principal. Secrets never enter a subject sandbox **by construction**, not by review.

**D4. Policy & metering: every session runs in a policy envelope.**
Envelope = capability set + resource mounts + caps. Subject default: create/continue own sessions, message, invoke granted connector types, read/write own overlay — **no** repo write, no config/trigger mutation, no secret read, no env delivery, no git push. Member default: today's behavior. Usage events carry the principal; caps enforce at the gateway pre-flight where account caps already live.

## 3. Verified seams (file:line) and their v1 role

| Seam | Today | v1 role |
| --- | --- | --- |
| [sandbox-env-sync.ts](../apps/api/src/projects/lib/sandbox-env-sync.ts) | Builds + pushes secret env, agent-scope-gated, boot + hot-push | The single choke point where subject sessions resolve to an **empty** secret env |
| [kortix.ts:427](../packages/db/src/schema/kortix.ts) `project_secret_scope='connector'` | Gateway-resolved, never injected | The broker precedent; generalized to per-principal resolution |
| [kortix.ts:411](../packages/db/src/schema/kortix.ts) `executor_connectors(_grants)` | member\|group connector sharing | Principal model precedent; informs `connections` shape |
| [kortix.ts:733](../packages/db/src/schema/kortix.ts) (comment) | `per_user` connector creds removed 2026-07-05 | Evidence the need existed; re-landed as `connections` keyed by principal |
| [index.ts:798](../apps/api/src/index.ts) `/v1/setup-links` | Public, pre-authorized secret/connector capture | Basis for hosted subject **connect links** (OAuth per end-user) |
| [repositories/scim.ts](../apps/api/src/repositories/scim.ts) | Hash-stored bearer tokens, status, revocation, `last_used_at` | Pattern for **subject session tokens** |
| [kortix.ts:1822](../packages/db/src/schema/kortix.ts) `usage_events` (+ per-session attribution at 1553) | Account/session metering | + nullable `subject_id` dimension; per-subject usage API + caps |
| [snapshots/templates.ts](../apps/api/src/snapshots/templates.ts) | Bake + boot prepared images, warm pool | **Releases**: bake `repo@commit`; subject sessions boot releases only |
| [engine-v2.ts](../apps/api/src/iam/engine-v2.ts) | Allow-only decision engine for members | Gains a `subject` actor kind resolving to the restrictive envelope |

## 4. Architecture

### 4.1 Subjects

```sql
CREATE TABLE kortix.subjects (
  subject_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  external_id  text NOT NULL,                 -- the wrapper's user id, opaque to us
  display_name text,
  status       text NOT NULL DEFAULT 'active',-- active | disabled
  caps         jsonb,                          -- per-subject overrides: {credits_month, tokens_day, ...}
  metadata     jsonb,                          -- wrapper-owned bag, returned verbatim
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_id)
);
```

Deliberately **not** members: no seat, no invite, no login, no IAM group membership. Disabling a subject revokes its tokens and blocks new sessions (same posture as SCIM deactivation: revoke fast, keep rows for attribution).

### 4.2 Subject session tokens

- Mint (server-to-server, PAT-authenticated): `POST /v1/projects/:projectId/subjects/:externalId/tokens` — upserts the subject, returns a short-TTL bearer (hash-stored, SCIM-token pattern) bound to `{subject_id, project_id, agent, capabilities, exp}`.
- The sandbox receives **only this token** (in the existing session-token slot). It authenticates the session stream, overlay file APIs, and broker calls — and authorizes nothing else.
- Revocation: `DELETE .../subjects/:externalId/tokens` (all) — same "revoke is never gated" rule as SCIM tokens.

### 4.3 Policy envelope

Session class derives from the actor: `member` → today's decisions; `subject` → fixed restrictive envelope (v1: not customizable per role — keep the matrix small until real demand):

| Capability | Subject |
| --- | --- |
| session create/continue (own), message, stream | ✅ |
| connector invoke — granted types, own profile | ✅ (broker) |
| overlay files read/write (own prefix, quota'd) | ✅ |
| repo write / git push / config / triggers / secrets | ❌ |
| env secret delivery (`runtime` scope) | ❌ — env resolves empty in [sandbox-env-sync.ts](../apps/api/src/projects/lib/sandbox-env-sync.ts) |
| see other subjects' sessions/files/connections | ❌ |

Enforced in three places, all existing choke points: route layer (engine actor kind), sandbox boot/hot-push (env + mount policy), gateway (per-call capability + cap check).

### 4.4 Releases

```sql
CREATE TABLE kortix.releases (
  release_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  commit_sha   text NOT NULL,
  manifest_hash text NOT NULL,
  snapshot_ref text,                            -- baked image (templates infra)
  status       text NOT NULL DEFAULT 'building',-- building | ready | retired
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, commit_sha)
);
```

`POST /v1/projects/:id/releases` bakes `repo@commit` via the existing template pipeline. **Subject sessions boot releases only**: `/repo` read-only, no clone, no git credential present. Member sessions are untouched in v1 (they keep the working tree — that *is* their overlay). Publishing is the operator's deliberate act — the wrapper's users never see un-released commits.

### 4.5 State overlay

- Mounts: `/repo` (RO release) + `/workspace` (the principal's overlay).
- **Member session:** overlay = repo working tree. Today's behavior, byte-identical, no migration.
- **Subject session:** overlay = per-subject object-store prefix (`kaab/{project}/{subject}/…`), materialized into the sandbox at boot and synced back by the daemon on write/close (v1: daemon-driven sync, not FUSE — simpler, good enough for files/memory; revisit if latency demands).
- Memory/brain writes resolve through the overlay path for subjects — same agent code, different mount.
- Quotas: per-subject bytes + object count enforced at sync; overruns fail the write with a typed error the agent can surface.

### 4.6 Connections & the broker

```sql
CREATE TYPE kortix.connection_principal AS ENUM ('project', 'member', 'subject');

CREATE TABLE kortix.connections (
  connection_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  connector_type  text NOT NULL,               -- 'gmail' | 'notion' | ...
  principal_type  kortix.connection_principal NOT NULL,
  principal_id    uuid,                         -- NULL for 'project'
  credentials_ref uuid NOT NULL,                -- encrypted credential row (KMS), 'connector' scope
  oauth_app_id    uuid,                         -- NULL = Kortix-owned OAuth app; else BYO (below)
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, connector_type, principal_type, principal_id)
);

CREATE TABLE kortix.oauth_apps (                -- wrapper-branded consent screens
  oauth_app_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  connector_type text NOT NULL,
  client_id     text NOT NULL,
  client_secret_ref uuid NOT NULL,              -- encrypted
  redirect_base text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

- **Resolution at call time (gateway):** subject profile → per-connector fallback policy (`none` — the safe default — or `project` shared credential for operator-owned connectors like an internal knowledge base). Member sessions resolve exactly as today until/unless migrated.
- **Broker flow:** sandbox emits `connector.invoke {type, method, args}` with its session token → gateway checks capability + resolves the caller's connection → decrypts server-side → executes (or attaches the token for pass-through executors) → returns the result. The `'connector'` scope already guarantees "never injected"; this only changes *which* credential resolves.
- **Hosted connect flow:** `POST /v1/projects/:id/subjects/:externalId/connect-links {connector_type}` → pre-authorized URL (setup-links pattern) → OAuth consent (Kortix-owned app, or the wrapper's own `oauth_apps` row so *their* branding appears) → callback stores `credentials_ref` on the subject's connection. The wrapper embeds or redirects; it never touches the tokens.

### 4.7 Metering & caps

- `usage_events.subject_id uuid NULL` — new dimension, populated for subject sessions (backfill-free).
- `GET /v1/projects/:id/subjects/:externalId/usage?from&to` — the wrapper's cost-attribution feed.
- Caps: `subjects.caps` checked at the gateway pre-flight alongside account caps; exceeding returns a typed 402-class error the wrapper can map to its own paywall.

## 5. API surface (v1)

Server-to-server (operator PAT):

```
PUT    /v1/projects/:id/subjects/:externalId            upsert (display_name, caps, metadata)
GET    /v1/projects/:id/subjects[?cursor]               list
DELETE /v1/projects/:id/subjects/:externalId            disable + revoke tokens
POST   /v1/projects/:id/subjects/:externalId/tokens     mint scoped session token
DELETE /v1/projects/:id/subjects/:externalId/tokens     revoke all
POST   /v1/projects/:id/subjects/:externalId/connect-links   {connector_type} → url
GET    /v1/projects/:id/subjects/:externalId/connections     list (types + status, never credentials)
DELETE /v1/projects/:id/subjects/:externalId/connections/:type
GET    /v1/projects/:id/subjects/:externalId/usage
POST   /v1/projects/:id/releases                        bake repo@commit
GET    /v1/projects/:id/releases                        list
```

Subject-token surface (called by the wrapper's client or server, scoped by the token itself): create/continue session, send message, stream, overlay file read/write. Nothing else resolves.

## 6. Threat-model deltas

| Threat | Answer |
| --- | --- |
| Prompt-injected credential exfil | Nothing to exfiltrate: env empty, broker executes server-side, only results cross the boundary |
| Stolen subject token | Short TTL, capability-scoped, per-subject revoke-all; token is useless outside its project/agent/subject |
| Cross-subject access | Overlay prefix + connection resolution + session visibility all key on the token's `subject_id` |
| Repo tampering | RO release mount, no git credential in subject sandboxes |
| Cost abuse | Per-subject caps at the gateway pre-flight; wrapper sees usage per subject and can cut off upstream |
| Sandbox egress | Phase 4: restricted egress policy for subject sessions (broker + LLM gateway + overlay endpoints only) |

## 7. Phases — independently shippable

**Phase 0 — this RFC + three decisions (§8).**

**Phase 1 — Subjects, sessions, metering ("wrap a base agent").**
- Migration (hand-written, repo convention): `subjects`, `usage_events.subject_id`.
- `repositories/subjects.ts` + token mint/validate (SCIM-token pattern).
- Session create accepts a subject actor; engine actor kind `subject` → restrictive envelope; env resolves empty in [sandbox-env-sync.ts](../apps/api/src/projects/lib/sandbox-env-sync.ts); repo mounted read-only for subject sessions (clone path retained but RO — releases land in Phase 4).
- Usage attribution + usage endpoint + caps pre-flight.
- **Acceptance:** a wrapper mints a token for `user-123`, opens a session on the shared agent, chats; a test asserts the sandbox env contains zero project secrets; usage rows carry `subject_id`; subject B cannot address subject A's session; disabling a subject kills its tokens.

**Phase 2 — Connections + broker (the hard core).**
- `connections` + `oauth_apps` migrations; repository + operator/subject APIs.
- Gateway connector resolution goes principal-first (today's shared-credential resolution — [kortix.ts:735](../packages/db/src/schema/kortix.ts) — becomes the `project` fallback).
- `connector.invoke` gateway route + sandbox tool shim; connect-links on the setup-links pattern; BYO OAuth apps.
- **Acceptance:** two subjects, one agent — each call uses the caller's own Gmail; a test greps sandbox env + fs for credential material and finds none; revoking a connection 403s the next invoke.

**Phase 3 — State overlay.**
- Object-store prefix per subject; daemon materialize/sync; overlay resolver (member → worktree unchanged, byte-identical); quotas; subject file APIs.
- **Acceptance:** subject files/memory persist across sessions and survive sandbox recycling; the repo shows zero subject writes; member-session behavior unchanged under the existing test suite.

**Phase 4 — Releases + hardening.**
- `releases` + publish API baking via [snapshots/templates.ts](../apps/api/src/snapshots/templates.ts); subject boot = release only (no clone); egress policy for subject sandboxes; optional: begin migrating member sessions' `runtime` secrets onto the broker for a single credential story.
- **Acceptance:** subject session boots with no git operation at all; un-released commits are invisible to subjects; egress from a subject sandbox is limited to gateway/overlay endpoints.

## 8. Decisions needed

1. **Per-subject custom code (skills/executors)** — recommendation: **out of v1**. Per-subject *state, connections, caps* yes; per-subject *code* means executing untrusted end-user code and is a different product surface. Revisit post-Phase-4 as an overlay-mounted skills dir behind the egress policy.
2. **Member sessions on the broker eventually?** — recommendation: **yes, as a Phase-4+ migration**, so there is one credential story and "env secrets" become legacy. Not a prerequisite for any phase.
3. **Overlay backend** — recommendation: **object-store prefix + daemon sync** for v1 (cheap at 100k subjects, no volume orchestration); per-subject volumes only if fs-semantics demand it later.

## 9. Non-goals (v1)

- Per-subject custom skills/executors/agents (decision 1).
- Any Kortix-hosted UI for end-users — subjects are API-only; the wrapper owns all UX except the OAuth consent hop.
- Wrapper-facing billing UI — usage is API-only; the wrapper bills its own users.
- Subject-visible dashboards, subject IAM roles, subject-to-subject sharing.

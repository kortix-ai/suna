# Kortix — Architecture Specification

> Source-of-truth document for what Kortix *is*. Read this before assuming anything about a subsystem.
> When this document and the code disagree, the document is the contract — fix the code.

---

## 0. One-line vision

**Kortix is the command center for an AI-native company: one Git repo = one project, every session is an isolated sandbox running OpenCode against that repo's branch, and the cloud platform owns identity, billing, secrets, connectors, triggers, and channels around it.**

The repo is the persistent source of truth (agents, skills, commands, memories, config). Sandboxes are ephemeral compute. Cloud APIs hold everything that needs to outlive a sandbox.

### 0.1 Intended end state

The intended end state is not "old Suna plus projects." It is a repo-backed company/project OS where web is the canonical product surface, the API is the control plane, and sandboxes are replaceable compute workers that clone a Git branch, run OpenCode, and disappear.

Compatibility exists only for one-time migration, billing recovery, and customer data preservation. Route aliases, mode flags, provider fallbacks, duplicated clients, or legacy wrappers with no current caller should be deleted instead of hardened.

### 0.2 Production-readiness path

The target is production-ready Kortix. The steps below are dependency gates toward production, not alternate release goals and not permission to stop early.

| Gate | Proves | Required before moving on |
|---|---|---|
| **1. Architecture foundation** | The tree matches the intended repo-first architecture. | Legacy `core/docker` scripts gone, empty packages removed or owned, typecheck repaired, no hidden `/instances` runtime path. |
| **2. Session runtime** | A Git-backed project can create a real session sandbox and reach OpenCode through the signed proxy. | Sandbox image builds, daemon validates HMAC context, session branch is created, `/kortix/health` is reachable, chat opens without legacy redirects. |
| **3. Multi-user correctness** | Accounts, invites, project roles, and session access work for real teams. | §10.2 account/project/session tests, §10.3 web flows, cross-account denial, invite acceptance, project-scoped session access. |
| **4. Secure cloud operation** | Production secrets and provider ownership are not hacks. | Project secrets, LLM router, GitHub App install/token flow, branch GC, idle hibernation, no human PAT dependency for repo creation. |
| **5. Production hardening** | The system can be handed to unknown users without manual babysitting. | Billing correctness, audit events, usage events, rate limits, observability dashboards, migration dry-run/apply, provider failure recovery, support/admin tooling. |

Triggers, project connectors, channels, Cloud Vault, and the cloud authorization gateway are now part of Gate 5 because webhook-fired sessions, external-tool execution, chat ingress, LLM profiles, and third-party account access are production surfaces. Memory v2 and full network egress proxying stay outside the first production-ready core unless the launch offer explicitly includes them; if promoted, they need tests and operational ownership before launch.

---

## 1. Domain model

```
Account
  └── members (User × Role)        roles: owner | admin | member
  └── projects (1..N)

Project
  ├── name, repo_url, default_branch
  ├── members (User × ProjectRole)  roles: manager | editor | viewer
  ├── vault bindings  (env vars, LLM profiles, OAuth/API credentials)
  ├── connectors      (MCP/OpenAPI/GraphQL/Pipedream/native sources)
  ├── triggers        (cron + webhook)
  ├── channels        (slack / telegram / msteams app installations)
  └── sessions (1..N)

Session
  ├── id (UUID, also == sandbox_id, also == git branch name)
  ├── owner User
  ├── status: provisioning | running | stopped | failed | completed
  ├── sandbox (1)     provider: daytona | local_docker | …
  └── opencode_session_id (1)   per OpenCode-side chat thread

SessionSandbox
  ├── provider (daytona | local_docker)
  ├── external_id  (provider's id)
  ├── base_url     (proxy URL surfaced to UI)
  └── config { service_key, image, … }
```

**Invariants:**
- **One UUID, three names**: `session_id` (our API), `sandbox_id` (our DB row in `session_sandboxes`), and `git branch name` (on the remote) are all the same UUID for a given session.
- **`external_id` is separate** — it's the provider's identifier for the underlying compute (Daytona's workspace UUID, a Docker container id, etc.). The sandbox proxy at `/v1/p/<external_id>/8000/*` uses `external_id`, NOT `sandbox_id`. Don't conflate them.
- A session has exactly one sandbox at a time. Re-running creates a new session (with a new UUID and new branch).
- A project has exactly one default branch (usually `main`); session branches fork from `default_branch`.
- Secrets never appear in git. Connectors never appear in git. Secret material, OAuth refresh tokens, LLM auth profiles, connector accounts, and Cloudflare credentials live in Cloud Vault or an external credential backend. The sandbox receives only explicitly scoped env vars and short-lived capability tokens for the LLM router and MCP integration gateway.

---

## 2. Surface map

### 2.1 The apps/ vs packages/ split

The rule, not negotiable:
- **`apps/<name>/`** — anything that produces a deployable artifact (you run `dev` or `build` on it). Each app has its own `package.json`, dev server, deploy story.
- **`packages/<name>/`** — anything imported by ≥2 apps OR anything whose lifecycle is independent of any single app (the DB schema is the canonical example). Always private workspaces, always `workspace:*` consumed.

If a package is only used by one app, it doesn't belong in `packages/` — inline it.

### 2.2 What's in the tree today

```
apps/web                         Next.js frontend (the only shipped client).
                                 /projects, /accounts, /invites; project shell
                                 with project sidebar; session view embeds
                                 SessionLayout+SessionChat against the sandbox.

apps/api                         Bun + Hono. The control plane.
                                 /v1/accounts, /v1/projects, /v1/account-invites,
                                 /v1/router, /v1/p (sandbox proxy).

apps/kortix-sandbox-agent-server The daemon that runs inside every sandbox.
                                 Boots opencode, reverse-proxies port 8000,
                                 exposes ONE /kortix/health endpoint.
                                 Bun-compiled single binary.

apps/sandbox                     The Docker image bundling the daemon +
                                 opencode + git. Built once, used by every
                                 sandbox provider as `kortix/sandbox:dev`.

packages/db                      Drizzle schema + client. Imported by apps/api.
                                 Single source of truth for: accounts,
                                 account_members, account_invitations, projects,
                                 project_members, project_sessions,
                                 session_sandboxes, + future tables herein.
                                 ↳ Justified as a package because the schema
                                   and migrations are versioned independently
                                   of api.

packages/shared                  Types + utilities used by BOTH apps/web and
                                 apps/api. The legitimate cross-cutting code.

packages/agent-tunnel            HMAC-signed tunnel relay (cloud ↔ local).
                                 Imported by apps/api, copied into the API
                                 Docker image, and exposes its own CLI/tooling.
                                 ↳ Keep only if "connect my local machine as a
                                   tool surface" is a real product surface. If
                                   it is not part of v1, remove the package,
                                   root dependency, API mounts, and Docker
                                   copies together. Do not keep a half-shipped
                                   tunnel compatibility layer.
```

**Parked / experimental** — present in the tree but not on the v1 critical path:
- `apps/desktop` — Tauri shell. Not a separate product architecture. It may wrap the web app later.
- `apps/mobile` — Expo shell. Not source of truth. It currently has legacy `/instances` and provider assumptions; rewrite against the web/API contract before parity.

Deleted from the v1 workspace path:
- `apps/kortix-v0` — exploratory web rebuild. It was not the shipped surface and was removed from the workspace.
- `packages/voice` — Python + Vapi config. It did not belong in the JS workspace release line.
- `packages/kortix-ocx-registry` — empty directory.

**Why keep a `packages/` dir at all?** Because the dependency direction matters: any app can depend on any package; no package may depend on an app. Enforcing this physically (separate dirs, separate `package.json`s, `workspace:*` deps) makes circular deps and accidental coupling impossible. Flattening everything into `apps/` would let `apps/api` import `apps/web` and we'd merge it.

`core/` is **deleted**. Anything referenced from there came back through `apps/` or `packages/`.

Known cleanup status from the real tree:
- Root sandbox scripts point at `apps/sandbox`; provider/setup code keeps root `.env` as the local source of truth and must not recreate deleted `core/docker` state. The local Gate 5 verifier guards this.
- `packages/voice` and `packages/kortix-ocx-registry` are deleted. Only `packages/agent-tunnel`, `packages/db`, and `packages/shared` remain on the v1 workspace path.
- Mobile and desktop can remain in the workspace, but they cannot define API behavior until they have been rewritten against `/v1/accounts`, `/v1/projects`, `/v1/projects/:id/sessions`, and `/v1/p`.

### 2.3 Product surfaces and ownership

| Surface | Owner | Contract |
|---|---|---|
| **Kortix web** | `apps/web` | Canonical client. Project list, account switching, sessions, files, settings, invite flows. No `/instances` navigation. |
| **Kortix API** | `apps/api` | Control plane. Auth, accounts, projects, sessions, sandbox proxy, billing, secrets, routers, migration jobs. |
| **Sandbox image** | `apps/sandbox` | Runtime artifact. Bakes daemon + OpenCode + git + optional CLI/MCP tools. Provider-neutral. |
| **Sandbox daemon** | `apps/kortix-sandbox-agent-server` | Thin trusted ingress inside sandbox: validate cloud-signed context, expose health, proxy to OpenCode. |
| **OpenCode agent layer** | Project repo `.opencode/*` | Agents, skills, commands, tools. Product configuration lives in Git, not in DB-only UI state. |
| **Daytona provider** | `apps/api/src/platform/providers/daytona.ts` | Default cloud compute provider. It supplies compute, not product state. |
| **local_docker provider** | `apps/api/src/platform/providers/local-docker.ts` | Dev/self-host provider. Must match the same daemon/image contract as Daytona. |
| **Mobile/Desktop** | `apps/mobile`, `apps/desktop` | Later clients over the same API/web contract. No separate instance model, no separate permission model. |

The architecture boundary is simple: product state belongs in Git or the cloud DB; runtime state belongs in the sandbox provider; client state is cache/UI preference only.

### 2.4 Zero-tech-debt rule for compatibility

Before preserving any compatibility path, search for real callers:
- If the caller is a migration job, billing recovery job, or data export path, keep it under a clearly named migration module and make it removable.
- If the caller is a current shipped web/API flow, move it to the new project/session vocabulary.
- If the caller is parked mobile/desktop/admin/demo code, do not let it force the v1 architecture.
- If there is no caller, delete the mode, route alias, prop, package, or fallback.

Compatibility is not a product surface. It is either a one-time bridge or dead code.

---

## 3. Concerns

### 3.1 Accounts & Members

- An **account** is the unit of ownership and billing. Personal account auto-created on first login; team accounts created via `POST /v1/accounts`.
- **Member roles** (`account_members.account_role`): `owner` | `admin` | `member`. Last-owner protection enforced server-side (can't demote/remove/self-leave if you're the last owner).
- **Invitations** (`kortix.account_invitations`): email-keyed. If invitee already has a Kortix account, instantly added. Otherwise a pending invite row; auto-claimed when their email signs up. No magic link tokens needed.
- **Billing** (cloud-only): per-seat ($20/member quoted) + per-compute. Stripe webhook → `kortix.billing_*` tables. Self-host has no billing surface.

### 3.2 Projects

- A **project** is one Git repo + Kortix metadata under one account.
- **Project members** (`project_members.project_role`): `manager` | `editor` | `viewer`. Account owners/admins are implicit `manager` on every project in the account.
- **Creating a project**:
  1. `POST /v1/projects/create-repo` — server uses the account's Kortix GitHub App installation token to create a fresh GitHub repo under the installed org/user, then commits the OpenCode starter scaffold (see §3.3) via the Contents API. Returns the project row.
  2. Alt: `POST /v1/projects` — register an existing repo by URL. The starter is NOT committed; the user is expected to scaffold their own.
- **Repo file reads** go through `/v1/projects/:id/files` and `/v1/projects/:id/files/content` — backed by a server-side bare-clone mirror at `KORTIX_GIT_CACHE_DIR`, refreshed every `KORTIX_GIT_REFRESH_INTERVAL_MS` (default 60s).

**Legacy fallback acknowledged**: if the GitHub App env is not configured, self-host/local dev can still use `KORTIX_GITHUB_TOKEN` + `KORTIX_GITHUB_OWNER`. This fallback is not the production path:
- All repos belong to one human's GitHub identity (audit / ownership / leaving).
- The PAT carries the user's entire scope — if leaked, blast radius is huge.
- Customers can't host their own repos under their own org without re-registering.

**The production path** is a Kortix GitHub App: each account installs the app on their org, the API uses an app-scoped installation token per request, repos are created under the customer's chosen org, session branch pushes use the same installation token, and sandbox clone gets only a short-lived token. Listed in §11 as a tracked decision.

### 3.3 Git as source of truth

The repo holds, in OpenCode-native shape:

```
kortix.toml                       project manifest (name, env requirements)
CONTEXT.md                        project-wide working context
.opencode/
  opencode.jsonc                  runtime config (providers, default_agent, …)
  agents/<name>.md                primary/subagent personas
  commands/<name>.md              slash-command templates
  skills/<name>/SKILL.md          on-demand instructions
  tools/<name>.ts                 (optional) custom tool implementations
.gitignore
README.md
```

The starter (defined in `apps/api/src/projects/starter.ts`) commits this scaffold on `create-repo`. Sessions clone this repo and let OpenCode read it.

**Decision: we do NOT introduce a custom DSL.** OpenCode's existing config format is the surface. Kortix-specific values that don't fit OpenCode (project name, env requirements) live in `kortix.toml` and are read only by Kortix-aware tooling, not by OpenCode itself.

### 3.4 Sessions & Sandboxes

- **One session = one sandbox = one git branch** (all keyed by the same UUID).
- Session creation (`POST /v1/projects/:projectId/sessions`):
  1. Generate UUID = `session_id`.
  2. Push a new git branch named after `session_id`, forked from `default_branch`, to the remote.
  3. Insert `project_sessions` row (`status='provisioning'`, `branch_name=session_id`, `sandbox_id=session_id`).
  4. Call `provisionSessionSandbox` (fire-and-forget) → the sandbox provider creates the sandbox row in `session_sandboxes` and starts the external resource.
  5. Return 201 immediately. Client polls `GET /v1/projects/:id/sessions/:sid/sandbox` until `status='active'`.
- **When sandbox becomes active**, the daemon inside has already done `git clone --branch <session_id>`; `provisionSessionSandbox` mirrors the success onto `project_sessions.status = 'running'`.
- **Session resume**: re-opening `/projects/:id/sessions/:sid` finds the existing sandbox row. If the provider says it's still `active`, we reconnect. If it's `stopped`, we restart (provider-dependent: Daytona supports start; local Docker re-runs the container). If the underlying sandbox is gone, the session is `archived` and a UI affordance lets the user fork a new session from the same branch.
- **Idle hibernation**: a sandbox that's seen no proxy traffic for `KORTIX_SANDBOX_IDLE_TTL` (default 1h) is stopped by the provider. Storage costs continue; compute costs don't. Trade: cold-start when the user comes back vs. running idle Daytona meters. Configurable per account on the cloud tier.
- **Branch GC**: session branches accumulate forever — every session adds one. After `KORTIX_BRANCH_RETENTION_DAYS` (default 90) of session status ∈ {`stopped`, `completed`, `failed`}, a cloud sweeper deletes the remote branch. Sessions linked to a still-open PR are skipped. The session row stays (audit trail); only the git branch is collected.
- **Persistence back to main**: agents commit + push to their session branch normally. To land changes in `default_branch`, open a GitHub PR. **No auto-merge** — humans approve. (Future: `POST /v1/projects/:id/sessions/:sid/promote` to fast-forward when there are no conflicts.)

### 3.5 Sandbox Agent Server (the daemon)

Lives at `apps/kortix-sandbox-agent-server/`. **Thin wrapper around opencode + one health endpoint.**

Boot sequence (already implemented):
1. Read env: `KORTIX_REPO_URL`, `KORTIX_DEFAULT_BRANCH`, `KORTIX_BRANCH_NAME`, `KORTIX_GITHUB_TOKEN`, `KORTIX_SERVICE_PORT`, `KORTIX_TOKEN`, `KORTIX_LLM_TOKEN`, `KORTIX_LLM_BASE_URL`, `KORTIX_CONNECTOR_TOKEN`, and `KORTIX_CONNECTOR_BASE_URL`.
2. If `KORTIX_PROJECT_AUTO_CLONE=1`: clone repo to `/workspace/.kortix` and checkout the session branch.
3. Spawn `opencode serve --port 4096 --hostname 127.0.0.1` with `OPENCODE_CONFIG_DIR=/workspace/.kortix/.opencode` (or fallback).
4. Bind Hono on `0.0.0.0:8000`.
5. Restart opencode on crash. Graceful SIGTERM/SIGINT.

API surface — **exactly three Kortix routes**:
- `GET /kortix/health` — `{ daemon, opencode, uptime_s, opencode_pid, repo, branch, commit_sha }`.
- `POST /kortix/refresh` — validates `X-Kortix-User-Context`, `git pull --ff-only` on the materialized session branch, then restarts opencode.
- `*` — reverse-proxied to opencode (HTTP, SSE, and WebSocket upgrade).

**Trust model (load-bearing):**
- Inbound traffic on `:8000` carries `X-Kortix-User-Context`, an HMAC-signed envelope minted by the cloud API at proxy time. Signature key is `KORTIX_TOKEN`, baked into the sandbox at create-time.
- The daemon **MUST validate the signature** before forwarding to opencode. Reject `401` on missing/invalid.
- Port `:8000` must NOT be publicly addressable. Reachability is via `/v1/p/<external_id>/...` only — the provider is responsible for the network boundary (Daytona's preview-domain auth, Docker's host-only port binding). Self-host operators who expose `:8000` directly bypass our auth model.
- Opencode itself binds `127.0.0.1:4096` — only the daemon talks to it. If the daemon dies, the sandbox is effectively offline (correct: no auth = no access).

**Explicit non-goals for the daemon:**
- It does NOT know about triggers, channels, connectors, secrets, preferences, billing, accounts, users, or projects.
- It does NOT call the cloud API.
- It exposes nothing on the host network besides port 8000.

### 3.6 Sandbox providers

`apps/api/src/platform/providers/` — a pluggable interface so the same daemon runs on different compute.

| Provider | Backed by | Today's status |
|---|---|---|
| `daytona` | Daytona Cloud | Default cloud path. |
| `local_docker` | `docker run kortix/sandbox:dev` | For self-host + dev. Image must exist locally. |
| `docker_sbx` | Docker Inc.'s sbx microVMs | Future. Architecturally similar to `local_docker`. |

Provider selection happens in `POST /v1/projects/:projectId/sessions { provider }`. Default: `daytona`. Whitelisted by `ALLOWED_SANDBOX_PROVIDERS` env var.

### 3.7 Secrets

**Decision: Cloud Vault is the target. `project_secrets` is the current runtime-env compatibility layer.** No git storage even encrypted. No OAuth refresh tokens or connector credentials in sandbox env by default.

Current DB:
```sql
kortix.project_secrets (
  secret_id    uuid PK,
  project_id   uuid FK -> projects,
  name         varchar(64),    -- env var name
  value_enc    text,           -- AES-256-GCM envelope via API_KEY_SECRET HKDF
  created_by   uuid,
  created_at   timestamptz,
  updated_at   timestamptz,
  UNIQUE (project_id, name)
)
```

API:
- `GET /v1/projects/:id/secrets` — list (names only, values never returned in plaintext).
- `POST /v1/projects/:id/secrets { name, value }` — upsert. Account owner/admin only.
- `DELETE /v1/projects/:id/secrets/:name`.

Sandbox-create flow currently injects project secrets as env vars alongside `KORTIX_*`. `KORTIX_*` names are reserved and rejected so users cannot shadow platform runtime variables. The daemon does not read or expose secret values.

Target model:
- All API keys, OAuth token sets, LLM auth profiles, connector accounts, Pipedream refs, Cloudflare tokens, webhook secrets, and env vars live in Cloud Vault.
- A vault item can be private, project-shared, account-shared, group-shared, or custom-granted.
- `use` never implies `reveal`.
- A session receives only the vault items selected and authorized at launch.
- Connector/OAuth/Cloudflare/LLM credentials are normally used through the cloud router or a future Executor-backed MCP bridge, not injected as raw env vars.

### 3.8 LLM providers

**Single-token router model, with auth profiles.** The sandbox carries **one** Kortix LLM token and a base URL. The cloud router resolves the selected LLM authentication profile server-side.

- Today, the session LLM router resolves `OPENROUTER_API_KEY` from project secrets and proxies OpenRouter-compatible chat completions.
- Target: Cloud Vault stores account/project/user LLM auth profiles for API keys, OpenRouter keys, ChatGPT/Codex OAuth-style profiles, Copilot-style profiles, Bedrock/Vertex/Azure credentials, and future providers.
- At sandbox-create, the API generates a short-lived `KORTIX_LLM_TOKEN` (HMAC-signed JWT scoped to that session) and injects it + `KORTIX_LLM_BASE_URL=https://<api>/v1/router/llm`.
- The chat/model selector chooses `model_provider + model + auth_profile`, so the same model can run against a personal profile, project profile, or account profile.
- The starter `opencode.jsonc` declares:
  ```json
  {
    "provider": {
      "kortix": {
        "npm": "@ai-sdk/openai-compatible",
        "env": ["KORTIX_LLM_TOKEN", "KORTIX_LLM_BASE_URL"],
        "options": { "baseURL": "{env:KORTIX_LLM_BASE_URL}", "apiKey": "{env:KORTIX_LLM_TOKEN}" },
        "models": { "anthropic/claude-sonnet-4-6": { … }, "openai/gpt-5": { … }, … }
      }
    }
  }
  ```
- The router (`apps/api/src/router/llm/*`) authenticates the token → resolves the user/account/project → looks up the real upstream key → proxies the call → bills usage.
- ChatGPT/Codex and other OAuth-backed profiles are provider-specific auth profiles, not regular env vars. Their refresh material stays server-side and can be shared as `use` without revealing tokens.

**Why:** sandbox holds zero real provider secrets. Sandbox tools (bash, web) can't exfiltrate keys. One token to rotate. Centralized usage tracking. Provider abstraction — agents say "claude-sonnet"; we pick the upstream.

**Real costs, not glossed over:**
- **Latency hop**: every LLM call routes through our infra. Expect +20–150ms over direct provider hit, depending on geography. For agent workloads dominated by token generation (≥1s TTFT), this is in the noise. For high-frequency tool-use loops it isn't.
- **SPOF**: when our router is down, every sandbox is effectively offline even if the provider isn't. We need to budget for ≥ provider-grade uptime on the router, or accept that we're now the bottleneck for everyone.
- **Streaming complexity**: we have to faithfully proxy SSE + provider-specific events (Anthropic's stop reasons, OpenAI's tool deltas). Every provider feature we don't proxy is a feature our customers can't use.

**The alternative we rejected** wasn't "raw provider keys forever" (strawman). It was **short-lived provider keys minted by the cloud**, scoped to one session, expiring in ≤1h, rotated on every session. The sandbox would call the provider directly. We rejected it because:
1. Most providers don't support session-scoped key minting (Anthropic doesn't; OpenAI's project keys are coarse).
2. Even a 1h leaked key is real damage on a per-token-billed account.
3. We give up the usage-tracking and abstraction wins.

But the alternative has a real argument and may come back if router latency becomes the complaint. Listed in the decision log so the reasoning isn't lost.

**Tradeoff for self-host**: the router runs alongside the API on the same box — same architecture, no internet dependency.

**Self-host BYOK:** users with their own API keys configure them in cloud secrets. Same flow.

### 3.9 Connectors / Integrations

Reserved for rebuild behind `@kortix/executor-bridge`. The previous project connector and Pipedream Connect implementation has been removed from the API, database schema, setup scripts, and web settings flow because it was the wrong abstraction to keep carrying through the refactor.

Replacement model:
- Connector sources are `mcp | openapi | graphql | pipedream | native | cloudflare`.
- Connector accounts are Vault-backed OAuth/API-key profiles with user/group/project/account grants.
- Sessions will receive an Executor MCP bridge URL/token only after the bridge is implemented and proven end-to-end.
- The future bridge authorizes every tool call, resolves credentials server-side, applies policies, creates approval requests when required, and writes audit events.
- Pipedream is a backend for managed auth, API proxy, and hosted MCP, not the Kortix permission source of truth.

There is intentionally no active connector/gateway API surface until the replacement connector model lands behind `@kortix/executor-bridge`.

### 3.10 Triggers

**Decision: 100% cloud-side. Sandbox never knows triggers exist.**

DB:
```sql
kortix.project_triggers (
  trigger_id   uuid PK,
  account_id   uuid FK,
  project_id   uuid FK,
  type         enum('cron', 'webhook'),
  config       jsonb,           -- { schedule: "*/5 * * * *" } OR { secret: "whsec_…" }
  agent_name   varchar,         -- which agent to invoke
  prompt_template text,         -- initial user message
  enabled      boolean,
  created_by   uuid,
  metadata     jsonb,
  last_fired_at,
  created_at, updated_at
)

kortix.project_trigger_events (
  event_id      uuid PK,
  trigger_id    uuid FK,
  account_id    uuid FK,
  project_id    uuid FK,
  status        enum('queued', 'fired', 'failed'),
  payload       jsonb,
  rendered_prompt text,
  session_id    text nullable,
  error         text nullable,
  created_at, updated_at
)
```

Fire path:
- **Cron**: a cloud-side scheduler (extends existing maintenance/scheduler infra) sweeps `enabled=true` triggers, evaluates schedules, on fire → same session-create path with `{ agent_name, initial_prompt }`. If the project is saturated, the trigger event queues and advances `last_fired_at` so one due schedule does not enqueue repeatedly.
- **Webhook**: public route `POST /v1/webhooks/:trigger_id`, HMAC-validated against `config.secret`. Same session-create path. Request body merged into the prompt template via `{{ body.* }}` substitution. Secrets are never echoed by trigger CRUD responses.

API surface:
- `GET/POST/PATCH/DELETE /v1/projects/:id/triggers/*`.
- `POST /v1/webhooks/:trigger_id`.

### 3.11 Channels

Reserved for rebuild under the same authorization gateway. A channel installation is a connector account plus an ingress policy. A channel event is an external actor that may start a session only with the resources granted to that channel or trigger. The previous channel implementation has been removed from the API and schema. The left sidebar keeps a Channels entry as a product placeholder, but there is intentionally no active `/v1/projects/:id/channels` or public `/v1/channels/:platform/:channel_id/events` surface until channel ingress is redesigned.

### 3.12 Agents / Skills / Commands / Tools

**Decision: OpenCode-native. No Kortix DSL.**

These all live as files in the project repo:
- `.opencode/agents/<name>.md` — primary or subagent. Frontmatter: `description, mode, permission, model, temperature, …`.
- `.opencode/skills/<name>/SKILL.md` — on-demand context the agent loads via the `skill` tool.
- `.opencode/commands/<name>.md` — slash-commands. Body is a prompt template with `$ARGUMENTS`, `!command`, `@path/to/file`.
- `.opencode/tools/<name>.ts` — custom TypeScript tools.

When you push to `main`, the next session clones the new config. When you push during a session, the user can hit `POST /kortix/refresh` on the daemon to pull + reload opencode without a new sandbox. (Both paths still rely on OpenCode picking up the changes from disk; opencode's reload semantics are the constraint.)

### 3.13 Memories / Brain

**Decision: v1 = files in the repo. v2 = a memory engine.**

For v1: `MEMORY.md` and `.opencode/skills/*` are how a project remembers things. Persistent because they're in git. No separate "memory store".

Future v2 (sketched, not specced): a cloud-side semantic store that:
- Lives in cloud (vector DB + relational metadata).
- Gets read on session boot via a `kmemory` MCP tool the agent calls.
- Writes go through a "memory maintenance agent" that decides what's worth keeping.
- Spans across sessions in the same project (and optionally across the account).

The boundary: anything that's *content* (skills, knowledge, examples) lives in git. Anything that's *embeddings* or *high-volume retrieval* lives in the cloud memory engine.

### 3.14 Permissions, Groups, Scopes

**Decision: account/project roles are the baseline; groups, resource grants, policies, and session launch scopes are now the target enterprise authorization layer.**

Today:
- Account-level: `owner | admin | member`.
- Project-level: `manager | editor | viewer`. Account managers get implicit `manager` on every project.
- Sandbox-level scoping: the user who owns the session can interact with that sandbox. Other project members can list/view sessions but can't run prompts in someone else's session.
- Secret scope today is project-level and account owner/admin managed. A session currently receives project env secrets at create-time.

Target:
- Groups inside an account.
- Resource grants for users, groups, account roles, project roles, agents, skills, triggers, channels, sessions, and API clients.
- Per-agent/per-skill/per-trigger/per-channel scoping.
- Per-secret, per-auth-profile, per-connector, per-Cloudflare-resource scoping.
- Session launch scoping for which secrets/connectors/auth profiles/cloud resources enter the session capability token.
- Human approval policies for sensitive agent actions.
- Network egress policies after the integration gateway exists.

### 3.15 Network egress

**Decision: not in v1.** Sandboxes today have unrestricted egress.

Future: egress proxy on the sandbox image that:
- Allows-lists destinations declared in `kortix.toml`.
- Substitutes secret values at the network layer (so the agent's process never holds raw secrets).
- Logs every outbound request for audit.

This is what unlocks "S-grade security" sales conversations.

### 3.16 Observability, audit, and metering

The spec previously did not address this. It must.

**Three streams, each with a stable home:**

1. **Structured logs** (`apps/api`, `apps/kortix-sandbox-agent-server`, web SSR):
   - JSON lines to stdout in dev; shipped to a managed sink (Vector → Loki/Datadog) in cloud.
   - Every log line MUST include `request_id`, `account_id`, `project_id`, `session_id` when applicable. Enforced via Hono middleware.
2. **Traces** (OpenTelemetry):
   - Span per inbound HTTP request, per outbound (provider, DB, GitHub), per LLM router proxied call.
   - Trace context propagated into the sandbox proxy headers so a single user click can be followed all the way to the LLM provider.
3. **Audit log** (`kortix.audit_events`):
   - Append-only DB table. Every state-changing API call writes one row: `{ event_id, account_id, actor_user_id, action, resource_type, resource_id, before, after, ip, user_agent, occurred_at }`.
   - Surfaced in account settings → "Activity" tab.
   - Retained ≥1 year in cloud; configurable in self-host.

**Metering (cloud only):** LLM router emits a `usage_event` per call into `kortix.usage_events` (input tokens, output tokens, cached tokens, provider, model, account, project, session). Rolled up nightly for billing. Self-host writes the same rows; Stripe sync is the only difference.

Current implementation:
- `kortix.audit_events` and `kortix.usage_events` exist in the cloud DB schema.
- Session creation, rate-limit hits, router usage, and other state-changing control-plane paths write audit/usage rows through shared helpers.
- Admin-only `GET /v1/ops/overview` exposes API status, tunnel status, account/project totals, session status, sandbox status/provider counts, trigger/channel queue status, audit activity, LLM usage by provider, and legacy migration status.
- Web admin `/admin/ops` renders those signals as the Operations dashboard.

Production gap:
- Full OTel trace propagation and a managed log sink are still required for production Gate 5. The dashboard is the support/control-plane surface, not a substitute for end-to-end traces or centralized logs.

### 3.17 Rate limiting and abuse

Missing from the original spec. Required.

- **Per-account compute caps**: max N concurrent sandboxes. Daytona provisioning rejects beyond cap with `429`.
- **Per-account LLM router caps**: token bucket on the router. Free tier = small bucket; paid = scales with plan.
- **Per-IP login throttling**: Supabase handles this for auth itself; for our `/v1/account-invites/:id/accept` flow we add a per-IP limiter (Hono middleware) to prevent invite-id enumeration.
- **Sandbox proxy abuse**: a sandbox cannot exceed `KORTIX_PROXY_REQS_PER_MIN` (default 600) — protects upstream opencode from a runaway agent.
- **Webhook trigger backpressure** (§3.10): when a project has N sessions already provisioning, additional webhook fires queue rather than spawning. Avoids accidental fork-bomb if a trigger source goes crazy.

All limits emit audit events on hit, with `X-RateLimit-Remaining` headers on responses.

Current implementation:
- Account session creation rejects at the API before branch creation or sandbox provisioning when active sessions (`queued | branching | provisioning | running`) meet the account's cap.
- Session-scoped `/v1/router/llm/*` uses a per-account token bucket; paid and legacy paid tiers get larger buckets.
- `/v1/account-invites/:id/accept` is per-IP throttled before auth to reduce invite-id enumeration.
- `/v1/p/:external_id/:port/*` is per-sandbox throttled after auth to protect the sandbox daemon/OpenCode service.
- Webhook trigger backpressure is implemented in the trigger router: signed fires insert a trigger event, queue when project provisioning or account caps are saturated, and otherwise reuse the same session creation path as the UI.

---

## 4. Lifecycle flows

### 4.1 Create project (new repo)

```
Web                          API                            GitHub
 |                            |                              |
 |  POST /v1/projects/        |                              |
 |  create-repo {name,        |                              |
 |  private, account_id}      |                              |
 |─────────────────────────▶  |                              |
 |                            |  POST /user/repos            |
 |                            |  (auto_init=true)            |
 |                            |─────────────────────────────▶ |
 |                            |  ◀── 201 repo metadata ────  |
 |                            |                              |
 |                            |  For each starter file:      |
 |                            |  PUT /repos/.../contents/X   |
 |                            |─────────────────────────────▶ |
 |                            |                              |
 |                            |  INSERT projects row         |
 |                            |  (account_id, repo_url, …)   |
 |                            |                              |
 |  ◀──── 201 project ──────  |                              |
```

### 4.2 Create session

```
Web                          API                            Daytona              Daemon
 |                            |                              |                    |
 |  POST /v1/projects/:id/    |                              |                    |
 |  sessions {provider?}      |                              |                    |
 |─────────────────────────▶  |                              |                    |
 |                            |  validate project access     |                    |
 |                            |  generate session_id UUID    |                    |
 |                            |  git push branch=session_id  |                    |
 |                            |  to GitHub (via cache mirror)|                    |
 |                            |                              |                    |
 |                            |  INSERT project_sessions     |                    |
 |                            |  status='provisioning'       |                    |
 |                            |                              |                    |
 |  ◀── 201 session row ────  |                              |                    |
 |                            |  ─── fire & forget ──        |                    |
 |                            |  provisionSessionSandbox()   |                    |
 |                            |                              |                    |
 |                            |  POST /sandbox (Daytona API) |                    |
 |                            |  snapshot=kortix-sandbox     |                    |
 |                            |  env=KORTIX_*                |                    |
 |                            |─────────────────────────────▶|                    |
 |                            |                              |  spawn container   |
 |                            |                              |  (image bakes      |
 |                            |                              |   /usr/local/bin/  |
 |                            |                              |   kortix-agent)    |
 |                            |                              |─────────────────▶ |
 |                            |                              |                    |  read env vars
 |                            |                              |                    |  git clone repo
 |                            |                              |                    |  checkout branch
 |                            |                              |                    |  spawn opencode
 |                            |                              |                    |  bind :8000
 |                            |                              |                    |
 |                            |  ◀─ container id + url ─────|                    |
 |                            |                              |                    |
 |                            |  UPDATE session_sandboxes    |                    |
 |                            |  status='active' +           |                    |
 |                            |  external_id + base_url      |                    |
 |                            |  UPDATE project_sessions     |                    |
 |                            |  status='running'            |                    |
 |  poll /sandbox endpoint    |                              |                    |
 |─────────────────────────▶  |                              |                    |
 |  ◀──── active + base_url ─ |                              |                    |
 |                            |                              |                    |
 |  call switchToSession-     |                              |                    |
 |  SandboxAsync, then        |                              |                    |
 |  mount SessionChat against |                              |                    |
 |  /v1/p/<ext_id>/8000/*     |                              |                    |
```

### 4.3 Trigger fires (future)

```
Cron worker (cloud)          API                            Daytona              Daemon
 |  every tick:               |                              |                    |
 |  SELECT triggers WHERE     |                              |                    |
 |  enabled AND due           |                              |                    |
 |                            |                              |                    |
 |  for each due trigger:     |                              |                    |
 |  POST /v1/projects/:id/    |                              |                    |
 |  sessions {agent_name,     |                              |                    |
 |  initial_prompt}           |                              |                    |
 |─────────────────────────▶  |  …same as 4.2…              |                    |
 |                            |                              |                    |
 |                            |  Once sandbox active:        |                    |
 |                            |  POST /v1/p/<ext>/session    |                    |
 |                            |  with initial_prompt         |                    |
 |                            |─────────────────────────────▶|──────────────────▶ |  opencode receives,
 |                            |                              |                    |  agent runs to completion
```

---

## 5. API surface (concrete)

Already implemented:
- `GET/POST /v1/accounts`, `GET/PATCH/DELETE /v1/accounts/:id`, members + invites under `/v1/accounts/:id`, `/v1/account-invites/:id/*`.
- `GET/POST/PATCH/DELETE /v1/projects`, `/v1/projects/:id`, `/v1/projects/:id/detail`, `/v1/projects/:id/files`, `/v1/projects/:id/files/content`, `POST /v1/projects/create-repo`, `GET/POST/DELETE /v1/projects/github/installation`.
- `GET/POST/DELETE /v1/projects/:id/secrets` (§3.7).
- `GET/POST/PATCH/DELETE /v1/projects/:id/sessions`, `GET /v1/projects/:id/sessions/:sid/sandbox`.
- `GET/POST/PATCH/DELETE /v1/projects/:id/triggers`, `POST /v1/webhooks/:trigger_id`, cron trigger sweeps, and `kortix.project_trigger_events` queue/fired/failed tracking (§3.10, §3.17).
- `/v1/p/<external_id>/8000/*` — sandbox proxy.
- `/v1/router/*` — search + legacy router proxies.
- `/v1/router/llm/*` — session-scoped LLM router (§3.8).
- `kortix.audit_events` and `kortix.usage_events` tables. State-changing `/v1/*` requests write audit rows; `/v1/router/llm/chat/completions` writes usage rows for streaming and non-streaming calls.
- Rate/abuse controls for account session caps, session LLM router buckets, invite acceptance throttles, and sandbox proxy caps (§3.17).

To add (in order):
1. Executor bridge runtime behind `@kortix/executor-bridge`: source registration, scoped credential resolution, session MCP issuance, approval policy evaluation, and audit logs. Ship each slice with API contract tests and cross-account denial tests.

---

## 6. Self-host vs cloud

| Concern | Cloud | Self-host |
|---|---|---|
| Identity | Supabase managed | Self-deployed Supabase |
| Billing | Stripe | Disabled |
| Sandbox provider | `daytona` default | `local_docker` default |
| LLM router | `/v1/router/llm` with Cloud Vault auth profiles | Same router code, points at the user's own Vault items |
| Connectors | Cloud-side authorization gateway + OAuth/Vault/Pipedream backends | Same API and gateway, backed by self-host credential storage |
| Triggers cron | Cloud-side scheduler | Same — `SCHEDULER_ENABLED=true` in the user's deployment |
| Egress proxy | Cloud-side | Optional |

Self-host means **the same code, same architecture, just running on the customer's infra**. The provider abstraction makes this work — they install the same image, they're just provisioning containers on their own Docker host instead of Daytona Cloud.

Sales rule: cloud is single-tenant per customer when sold via partner consultancies. We never co-tenant enterprise customers.

---

## 7. Migration from legacy

The old `/instances` system (one-sandbox-per-account, `kortix.sandboxes` table, sandbox-scoped invites/members, etc.) is dead. The migration plan:

1. **DB**: legacy tables (`kortix.sandboxes`, `kortix.sandbox_members`, `kortix.sandbox_invites`, etc.) stay in the schema as cold archives. No new code reads or writes them. A future migration can `DROP TABLE` once we're sure.
2. **For existing customers with state in `kortix.sandboxes`**: a one-time migration job — for each active sandbox, create a project (with a fresh GitHub repo), `git init` the workspace contents into it, start a session sandbox from that repo. Done. The user's project URL changes; their files survive.
3. **Cluster downtime is acceptable** for the migration window — the user said an hour is fine.
4. **Frontend**: `/instances/*` routes are already deleted. The legacy UI is unreachable.
5. **Components**: anything reused from the legacy shell (SidebarLeft, SessionChat, etc.) was moved under `apps/web/src/components/` and stays. The route trees are gone.
6. **Old "core/" package**: deleted. Anything we need from it gets cherry-picked from `git log -- core/` when bringing a feature back.

Implemented operational tooling:
- `kortix.legacy_sandbox_migrations` is the removable journal for this one-time migration only. It records the source sandbox, target project/session ids, planned repo URL, rollback metadata, status, and errors.
- `pnpm --filter kortix-api migration:legacy-sandboxes -- --dry-run --repo-url-template 'https://github.com/<org>/{slug}-{sandbox_id}.git'` prints the exact project/session/runtime rows that would be created.
- `--apply` requires `--repo-url-template`; it creates/repairs the account row, preserves sandbox members as account/project access, converts pending sandbox invites to account invites, creates project/session/session sandbox rows using the invariant `session_id == sandbox_id == branch_name`, and archives the legacy sandbox row.
- `--verify` checks the applied migration has project, session, runtime row, archived legacy row, and id invariants.
- `--rollback` deletes the created project/session/runtime rows, removes migration-created account members/invites/accounts, and restores the legacy sandbox status/metadata from the journal.
- The job assumes the downtime runbook has already exported/imported workspace files into the repo URL produced by the template. It does not keep a live compatibility reader for old sandbox storage.

Migration is not a standing compatibility mode:
- No dual-write between legacy sandboxes and project sessions.
- No route aliases from project sessions back to `/instances`.
- No provider fallback to `justavps` for project sessions.
- No mobile/desktop exception that keeps the old instance model alive.
- If a legacy artifact is needed after migration, expose it as an archived read-only import or export, not as an active runtime path.

---

## 8. Future (explicitly out of scope for now)

- Mobile + desktop parity beyond the current webview shell.
- Marketplace / templates ("Shadcn-style add files to existing projects").
- Memory engine (§3.13 v2).
- Full network egress proxying (§3.15). Gateway-level connector authorization lands first.
- Multiple sandbox templates per project (one Dockerfile per project for now).
- Apps concept (Fly.io-style persistent services declared in `kortix.toml`).
- Sandbox engine pluggability beyond Docker — WASM, Firecracker, microVMs (`docker_sbx` is the first non-Docker path).
- "Persistent volume across sessions" — the v0 model is everything-in-git. A persistent disk shared across sessions would require defining merge semantics; revisit when there's a real use case the git model doesn't cover.

---

## 9. Glossary

- **Account** — billing + identity unit. Owns projects. Has members.
- **Project** — one Git repo + Kortix metadata. The unit a session runs against.
- **Session** — one execution of an agent on a project. Has a sandbox, has a git branch.
- **Sandbox** — the compute environment a session runs in. Provider-backed (Daytona, local Docker, …).
- **Sandbox Agent Server** — the daemon (`apps/kortix-sandbox-agent-server`) that runs inside every sandbox. Wraps opencode.
- **Sandbox Image** — the Docker image (`apps/sandbox`) that bundles the daemon + opencode + git.
- **Daemon health** — `GET /kortix/health` on port 8000. The only Kortix-specific endpoint inside the sandbox.
- **Cloud router** — `/v1/router/*` on the API. Proxies LLM calls so provider secrets do not need to reach the sandbox.
- **Cloud Vault** — encrypted resource store for env vars, API keys, OAuth token sets, LLM auth profiles, connector accounts, webhook secrets, and Cloudflare tokens.
- **Integration gateway** — cloud-side MCP gateway that exposes only authorized tools/connectors to a session and resolves credentials server-side.
- **Trigger** — cron or webhook event that fires a session.
- **Channel** — chat-app installation (Slack/Telegram/MS Teams) that pipes messages to sessions. Special-case of trigger + connector.
- **Connector** — third-party integration (Notion/Linear/Gmail/…) the agent can call. Cloud-managed, proxied via the connector layer.
- **Skill** — on-demand instructions an agent loads. Lives in `.opencode/skills/<name>/SKILL.md` in the project repo.
- **Memory** — content that persists across sessions. v1: files in git. v2: semantic store.
- **external_id** — the sandbox provider's identifier for a running compute unit (Daytona workspace UUID, Docker container id). Used in the proxy URL `/v1/p/<external_id>/...`. Distinct from `sandbox_id` (our row id) and `session_id` (the UUID shared with the branch).
- **KORTIX_TOKEN** — symmetric secret injected into each sandbox at create-time. Used to verify `X-Kortix-User-Context` envelopes signed by the API.
- **X-Kortix-User-Context** — HMAC-signed envelope (signed with `KORTIX_TOKEN`) that the sandbox proxy attaches to every forwarded request. The daemon validates it before handing off to opencode.
- **Audit event** — row in `kortix.audit_events`. Every state-changing API write produces one.
- **Usage event** — row in `kortix.usage_events`. One per LLM/connector call routed through the cloud router.

---

## 10. End-to-end test plan

This section is **the contract**. If a flow described here fails, the system is broken — regardless of what unit tests pass. Run these against a live stack (API on `:8008`, web on `:3000`, local Supabase on `:54321/:54322`, Daytona reachable).

### 10.1 Test harness

Three layers, run in this order:

| Layer | Tool | Where it lives |
|---|---|---|
| **API contract** | curl + `jq` / Bun's `fetch` | `tests/api/*.test.ts` (Bun test runner) |
| **Web UI** | chrome-devtools MCP (today), Playwright (later) | `tests/web/*.spec.ts` |
| **CLI** | Bun test shelling out to `kortix` binary | `tests/cli/*.test.ts` (when CLI lands) |
| **E2E golden paths** | Bun test, drives API + waits + asserts DB | `tests/e2e/*.test.ts` |

**Test fixtures** (created once per run, torn down at end):
- `marko@kortix.ai` — primary test user. JWT obtained via Supabase `admin/generate_link` → `verify` (the exact flow already used in chat: see `/tmp/jwt`).
- `kortix-demo-project` — a fixture project pre-seeded with the OpenCode starter.
- `ALLOWED_SANDBOX_PROVIDERS=daytona,local_docker` — both providers exercised.

**Assertion vocabulary** used below:
- `status 2XX` — HTTP 2xx range.
- `shape { … }` — JSON keys present with the listed types.
- `db.<table>:<column>=<value>` — direct DB assertion after the request.
- `side-effect: …` — a non-DB consequence (sandbox provisioned, branch pushed, etc.) that should be verifiable independently.

---

### 10.2 API contract tests

Every endpoint listed below has: **pre-conditions**, **request**, **assertions**, **failure modes**.

#### 10.2.1 Accounts

##### `GET /v1/accounts`
- **Pre**: authenticated user.
- **Assert**: `status 200`. Returns `array of { account_id, name, slug, personal_account, account_role, is_primary_owner }`.
- **Side-effect**: if user had no `account_members` row, one is auto-created with a real `kortix.accounts` row + `accountRole='owner'`. Verify by querying `kortix.account_members WHERE user_id = $user`.
- **Failure**: unauthenticated → `401`.

##### `POST /v1/accounts { name }`
- **Pre**: authenticated user. `name` non-empty, ≤255 chars.
- **Assert**: `status 201`. Returns the created account. `db.kortix.accounts:personal_account=false`. `db.kortix.account_members:user_id=$user,account_role='owner'`.
- **Failure**: missing/empty `name` → `400 { error: 'name is required' }`. Over-length → `400 { error: 'name is too long' }`.

##### `GET /v1/accounts/:id`
- **Pre**: caller is a member of the account.
- **Assert**: `status 200`. Shape `{ account_id, name, personal_account, member_count, role, created_at, updated_at }`. `role` matches caller's `account_members.account_role`.
- **Failure**: non-member → `403`. Unknown id → `404`.

##### `PATCH /v1/accounts/:id { name }`
- **Pre**: caller is `owner`.
- **Assert**: `status 200`. `db.kortix.accounts:name=<new>`.
- **Failure**: non-owner → `403`. (Personal account renames are ALLOWED — explicit decision.)

##### `GET /v1/accounts/:id/members`
- **Pre**: caller is a member.
- **Assert**: `status 200`. Array of `{ user_id, email, account_role, joined_at }` — emails resolved via Supabase admin.

##### `POST /v1/accounts/:id/members { email, role? }`
- **Pre**: caller is `owner` or `admin`. `role ∈ {admin, member}`, default `member`.
- **If invitee already a Supabase user**:
  - **Assert**: `status 201 { status: 'added', user_id, email, account_role }`. `db.kortix.account_members` has the new row.
- **If invitee NOT a Supabase user**:
  - **Assert**: `status 201 { status: 'pending', invite_id, email, account_role, expires_at }`. `db.kortix.account_invitations` row inserted (or upserted on `(account_id, email)` if pending exists).
- **Failure**: already member → `409 { error: 'Already a member' }`. Non-owner/admin → `403`.

##### `DELETE /v1/accounts/:id/members/:userId`
- **Pre**: caller is `owner` or `admin`. Target is not the last owner.
- **Assert**: `status 200 { ok: true }`. Row removed.
- **Failure**: last-owner removal → `409`. Non-owner removing an owner → `403`.

##### `PATCH /v1/accounts/:id/members/:userId { role }`
- **Pre**: caller is `owner`. Not demoting the last owner.
- **Assert**: `status 200`. Updated role in DB.
- **Failure**: last-owner demotion → `409`.

##### `POST /v1/accounts/:id/leave`
- **Pre**: caller is a member, not the last owner, not a personal account.
- **Assert**: `status 200 { ok: true }`. Row removed.
- **Failure**: last owner → `409`. Personal account → `409`.

##### `GET /v1/accounts/:id/invites`
- **Assert**: `status 200`. Array of pending invites (accepted=null AND expires_at>now).

##### `DELETE /v1/accounts/:id/invites/:inviteId`
- **Assert**: `status 200 { ok: true }`. Row deleted.

##### `POST /v1/accounts/:id/invites/:inviteId/resend`
- **Assert**: `status 200 { ok: true, expires_at }`. `expires_at` bumped.

##### `GET /v1/account-invites/:inviteId`
- **Public-ish** (still auth-required) — caller may or may not be the invitee.
- **If caller's email matches invite email**: full shape `{ invite_id, email, account_id, account_name, initial_role, inviter_email, created_at, expires_at, expired, email_matches_caller: true, accepted_at }`.
- **Otherwise**: redacted `{ invite_id, email_matches_caller: false, expired, accepted_at, … nulls }`.

##### `POST /v1/account-invites/:inviteId/accept`
- **Pre**: caller's email matches. Not expired. Not accepted.
- **Assert**: `status 200 { account_id, account_role }`. `db.kortix.account_members` has the new row. `db.kortix.account_invitations:accepted_at` set.
- **Failure**: wrong email → `403`. Expired → `410`. Already accepted → `200 { already_accepted: true }`.

#### 10.2.2 Projects

##### `GET /v1/projects?account_id=...`
- **Assert**: `status 200`. Array of `{ project_id, account_id, name, repo_url, default_branch, manifest_path, status, project_role, effective_project_role, … }`. For `member` (not `owner/admin`), only projects they're explicitly a `project_members` of show up.

##### `POST /v1/projects/create-repo { name, private?, account_id?, description? }`
- **Pre**: caller is `owner` or `admin` on the account. `KORTIX_GITHUB_TOKEN` configured.
- **Assert**: `status 201`. Returns serialized project. `db.kortix.projects:repo_url` matches the created GitHub repo's clone URL.
- **Side-effects**:
  - GitHub repo exists at `https://github.com/<KORTIX_GITHUB_OWNER>/<name>` (verify via `GET /repos/...`).
  - Repo has the starter scaffold committed: `README.md`, `kortix.toml`, `CONTEXT.md`, `.gitignore`, `.opencode/opencode.jsonc`, `.opencode/agents/default.md`, `.opencode/agents/reviewer.md`, `.opencode/commands/plan.md`, `.opencode/commands/test.md`, `.opencode/skills/git-workflow/SKILL.md`.
- **Failure**: invalid name (e.g. `name="bad name"`) → `400`. GitHub API failure → `502 { error: <message> }`. No token configured → `503`.

##### `POST /v1/projects { repo_url, name?, default_branch?, manifest_path?, account_id? }`
- **Pre**: caller is account member. URL non-empty.
- **Assert**: `status 201`. `db.kortix.projects` row. Upsert on `(account_id, repo_url)` — same URL re-registers same row.
- **No starter commit** (this is the existing-repo path).

##### `GET /v1/projects/:projectId`
- **Pre**: caller has project read access (member of owning account, OR explicit `project_members` row).
- **Assert**: `status 200`. Shape per §1. `db.kortix.projects:last_opened_at` bumped.
- **Failure**: archived project → `404`. Non-member → `403`.

##### `GET /v1/projects/:projectId/detail`
- **Assert**: `status 200`. Returns `{ project, config, file_count, files }`. `config` is parsed `kortix.toml` + `.opencode/` summary (agents, skills, env requirements).

##### `GET /v1/projects/:projectId/files?ref=&path=`
- **Assert**: `status 200`. Array of `{ path, type: 'file', size }`. Up to 1000 entries.

##### `GET /v1/projects/:projectId/files/content?path=&ref=`
- **Assert**: `status 200 { path, ref, content }` (UTF-8).
- **Failure**: missing `path` → `400`.

##### `PATCH /v1/projects/:projectId { name?, default_branch?, manifest_path? }`
- **Pre**: caller has `manager` effective role.
- **Assert**: `status 200`. Updated fields persisted.

##### `DELETE /v1/projects/:projectId`
- **Pre**: caller has `manager` effective role.
- **Assert**: `status 200 { ok: true }`. `db.kortix.projects:status='archived'`. Subsequent reads → `404`.

#### 10.2.3 Sessions

##### `POST /v1/projects/:projectId/sessions { base_ref?, name?, agent_name?, provider? }`
- **Pre**: caller has `editor`+ project access. Project not archived.
- **Validation**: `provider ∈ ALLOWED_SANDBOX_PROVIDERS`. Default `daytona`.
- **Assert response**: `status 201`. Shape `{ session_id, account_id, project_id, branch_name, base_ref, sandbox_provider, sandbox_id, status: 'provisioning', … }`.
- **Invariant**: `session_id === sandbox_id === branch_name`.
- **Side-effects** (immediate):
  - `db.kortix.project_sessions` row inserted with `status='provisioning'`.
  - Git branch `<session_id>` pushed to the project's remote (verify via `GET /repos/.../branches/<session_id>`).
  - **Fire-and-forget**: `kortix.session_sandboxes` row appears within ~500ms with `status='provisioning'`. Eventually transitions to `'active'` (Daytona ~30s; local_docker ~10s).
- **Failure modes**:
  - Unknown provider → `400 { error: 'Unknown sandbox provider: <name>' }`.
  - Branch push fails → `502`. No DB row inserted.
  - Provisioning fails in background → `db.kortix.project_sessions:status='failed'` + error message; `db.kortix.session_sandboxes:status='error'`.

##### `GET /v1/projects/:projectId/sessions`
- **Assert**: `status 200`. Array of sessions, ordered `updated_at desc`.

##### `GET /v1/projects/:projectId/sessions/:sessionId`
- **Assert**: `status 200`. Single session shape.
- **Failure**: invalid UUID → `400`. Not found → `404`.

##### `GET /v1/projects/:projectId/sessions/:sessionId/sandbox`
- **Assert**: `status 200`. Shape `{ sandbox_id, session_id, project_id, account_id, provider, external_id, base_url, status, metadata, created_at, updated_at }`.
- **State transitions to verify**: `provisioning` → `active` (happy path), `provisioning` → `error` (failure path), `active` → `stopped` (manual stop).
- **Failure**: sandbox row not yet inserted → `404`. (Frontend polls.)

##### `PATCH /v1/projects/:projectId/sessions/:sessionId { name?, opencode_session_id?, metadata? }`
- **Assert**: only the listed user-controlled fields are accepted. `status`, `sandbox_url`, and `error` are owned by the provisioner — attempting to set them returns `400 { error: 'field is server-managed' }`. Others → `400`.

##### `DELETE /v1/projects/:projectId/sessions/:sessionId`
- **Assert**: `status 200 { ok: true }`. `db.kortix.project_sessions:status='stopped'`. The git branch is **NOT** deleted from the remote (preserve work for merging).

#### 10.2.4 Sandbox proxy (`/v1/p`)

##### `GET /v1/p/:externalId/:port/*`
- **Pre**: sandbox row in `session_sandboxes` with `external_id=<id>` AND `status='active'`. Caller is a member of the owning account (or platform admin).
- **Assert response**: `status 200` (for `/kortix/health` and OpenCode endpoints). Body is whatever opencode/daemon returns.
- **Side-effect**: `X-Kortix-User-Context` header signed and forwarded to the sandbox. Logged at the API: `[PREVIEW] signing X-Kortix-User-Context user=<uid> sandbox=<id> role=member`.
- **Failure (deterministic codes — no aliasing)**:
  - No matching sandbox row → `404 { error: 'sandbox not found' }`.
  - Sandbox row exists with `status ∈ {provisioning, stopped, error}` → `503 { error: 'sandbox not ready', status }` (the client polls).
  - Caller not in owning account → `403`.
  - Sandbox proxy upstream unreachable → `502`.
  - Daemon rejects `X-Kortix-User-Context` (signature mismatch) → `401` from daemon, surfaced as `502` to client (daemon misconfig = proxy fault).

#### 10.2.5 Health + daemon endpoints (inside the sandbox)

##### `GET /kortix/health` (via proxy: `GET /v1/p/<external>/8000/kortix/health`)
- **Assert**: `status 200`. Shape `{ daemon: 'ok', opencode: 'ok'|'starting'|'down', uptime_s, opencode_pid, repo, branch, commit_sha }`.
- **Invariant**: while `opencode != 'ok'`, all non-`/kortix/*` requests via the proxy return `503`. Once `opencode === 'ok'`, they pass through.

##### `POST /kortix/refresh` (via proxy: `POST /v1/p/<external>/8000/kortix/refresh`)
- **Pre**: caller reaches the sandbox through the proxy, so `X-Kortix-User-Context` is signed.
- **Assert success**: `status 200`, body includes `{ ok: true, repo: { before, after }, opencode, opencode_pid }`.
- **Side-effect**: materialized repo fast-forwards from origin and opencode restarts.
- **Failure**: missing/invalid signed context → `401`; no materialized repo or non-fast-forward pull conflict → `409`.

##### `GET /app` (opencode's own SPA, via proxy)
- **Assert** (when sandbox active and opencode ready): `status 200`, `Content-Type: text/html`, body contains `<title>OpenCode</title>`.

##### Repo cloned correctly
- **Assert** (after sandbox active): `GET /v1/p/<external>/8000/file?path=.` returns the project's repo-root listing including `.opencode/` and the starter files.

---

### 10.3 Web UI tests

Run via chrome-devtools MCP today, Playwright once a runner is wired. Each test starts logged in (Supabase magic-link sets cookies as in §10.1).

#### 10.3.1 Project shell loads

1. `navigate /projects/<projectId>`.
2. **Assert** URL stays at `/projects/<id>/files` (the redirect from `/projects/<id>`).
3. **Assert** sidebar present: logo links to `/projects`, "New session" button, "Sessions" collapsible, "Files" + "Settings" footer buttons, user menu at bottom.
4. **Assert** no `/instances/...` href anywhere in the snapshot (regression guard).
5. **Assert** no right-rail with Files/Terminal/Secrets/Triggers/Tunnel buttons (regression guard from the legacy SidebarRight).

#### 10.3.2 Session create + chat

1. `navigate /projects/<projectId>/sessions`.
2. Click "New session". **Assert** URL changes to `/projects/<id>/sessions/<sessionId>` (a fresh UUID).
3. **Assert** ConnectingScreen shown with "Provisioning session" stage.
4. Poll up to 60s. **Assert** ConnectingScreen unmounts and `SessionLayout`+`SessionChat` mount.
5. **Assert** in the rendered DOM: a `<textarea>` for chat input, agent picker, model picker.
6. **Assert** sidebar "Sessions" group lists the new session (refetch within 5s — sidebar polls).
7. **Assert** URL stayed on `/projects/<id>/sessions/<sid>` throughout (regression guard against `/instances/...` and bare `/sessions/...`).

#### 10.3.3 GitHub one-click open

1. On a project page, **assert** the sidebar shows the "open on GitHub" pill (expanded) and the github icon in the collapsed rail.
2. Click pill. **Assert** new tab opens with `href` equal to the repo's `html_url`.

#### 10.3.4 Account switcher + create-team

1. Click the account pill in `AppHeader`. **Assert** dropdown shows current account list + "Create account" + "Account settings".
2. Click "Create account", enter name, submit. **Assert** new account appears in dropdown and is auto-selected.
3. **Assert** the global `useCurrentAccountStore` reflects the new selection (localStorage `kortix.currentAccount` updated).

#### 10.3.5 Member invite

1. Open `/accounts/<accountId>`.
2. Click "Invite member", enter `nobody@nowhere.test`, role=`member`. Submit.
3. **Assert** toast: "Invite sent — they'll see it when they sign up".
4. **Assert** "Pending invites" section shows the new row.
5. Sign in as that email (auto-claim path). **Assert** the user lands with the team account already present in their account list.

#### 10.3.6 No legacy redirects

Run after every release. Open each of these and assert URL stays in `/projects/...`:
- Click any session in the sidebar.
- Click "Files" or "Settings" in the sidebar.
- Reload the page mid-session.
- Switch accounts via the account switcher while on a project page.

If any of these jumps to `/instances/...` or `/dashboard` or bare `/sessions/<id>`, the test fails.

---

### 10.4 CLI tests (future — when `kortix` ships)

The CLI is in the spec (`kortix init` / `kortix deploy` / `kortix start`) but not implemented yet. When it lands:

#### `kortix init <name>`
- Creates `./<name>/` with the starter scaffold mirroring `apps/api/src/projects/starter.ts`.
- **Assert**: directory contains `kortix.toml`, `.opencode/`, etc.
- **Assert**: `git init` + initial commit present.

#### `kortix deploy`
- Requires logged-in CLI session (token cached in `~/.kortix/credentials`).
- Reads current dir's git remote, calls `POST /v1/projects { repo_url }` against the cloud API.
- **Assert**: project visible at `kortix.com/projects/<id>`.

#### `kortix start [--project <id>]`
- Spins up the API + web locally pinned to one project.
- **Assert**: `:8008/health` returns 200. `:3000` loads. Local Daytona OR local_docker provider is the active sandbox path.

---

### 10.5 End-to-end golden paths

These are multi-step scenarios. They run sequentially in `tests/e2e/`.

#### E2E-1: First-time user creates a project and runs a session
1. Sign up `alice@example.test`. **Assert** auto-personal-account created.
2. `POST /v1/projects/create-repo { name: 'demo' }`. **Assert** repo on GitHub + 10 starter files committed.
3. `POST /v1/projects/<id>/sessions {}`. **Assert** session row created, sandbox provisioning.
4. Poll `/v1/projects/<id>/sessions/<sid>/sandbox` until `status='active'`. (Up to 60s.)
5. `GET /v1/p/<external>/8000/kortix/health` → `daemon: 'ok'`, `opencode: 'ok'`.
6. `GET /v1/p/<external>/8000/file?path=.opencode` returns starter agents.

#### E2E-2: Two accounts, one user member of both
1. Sign up `alice@example.test`. **Assert** personal account.
2. `POST /v1/accounts { name: 'Acme' }`. **Assert** Acme account created.
3. `GET /v1/accounts`. **Assert** two rows.
4. Create a project under each. **Assert** `GET /v1/projects` returns only the queried account's projects.
5. Switch active account in web UI. **Assert** `/projects` list updates.

#### E2E-3: Invite a user who hasn't signed up
1. As `alice`, `POST /v1/accounts/<id>/members { email: 'bob@example.test', role: 'member' }`. **Assert** `status: 'pending'`.
2. **Assert** `db.kortix.account_invitations` row.
3. Bob signs up via Supabase. **Assert** on his first `GET /v1/accounts`, the invitation is auto-claimed and the team account is in his list.

#### E2E-4: Session decoupled from legacy table (regression)
1. Create a session sandbox on Daytona. **Assert** `db.kortix.session_sandboxes` row exists with `status='active'`.
2. **Assert** `db.kortix.sandboxes` has ZERO rows referencing this sandbox_id.
3. **Assert** `/v1/p/<external>/8000/kortix/health` returns 200 (proves the proxy reads from `session_sandboxes`).

#### E2E-5: Provider switch (local_docker)
1. `docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:dev .`. **Assert** image builds.
2. `POST /v1/projects/<id>/sessions { provider: 'local_docker' }`. **Assert** session created.
3. Poll the sandbox endpoint. **Assert** transitions to `active`. `external_id` is the container id (not a UUID).
4. `docker ps` — **assert** a container named `kortix-session-<prefix>` is running with port 8000 mapped.
5. `GET /v1/p/<container_id>/8000/kortix/health` → 200.

#### E2E-6: New session loads the chat thread without redirect (the bug we kept hitting)
1. Web UI: click "New session" on `/projects/<id>/sessions`.
2. **Assert** URL: `/projects/<id>/sessions/<sid>` and never anything else.
3. **Assert** within 60s: textarea visible, no "Reaching workspace" spinner, no right-rail with Terminal/Secrets/Triggers buttons.
4. Refresh the page. **Assert** URL unchanged, chat still loads.

#### E2E-7: Webhook trigger fires and runs a session
1. Create a webhook trigger pointing at agent `default`, prompt `Process: {{ body }}`, with `config.secret`.
2. `POST /v1/webhooks/<trigger_id> { foo: 'bar' }` with valid `sha256=` HMAC.
3. **Assert** invalid/missing HMAC returns `401` before event creation.
4. **Assert** a valid fire creates `kortix.project_trigger_events(status='fired')`, creates a new session row, provisions a sandbox with `KORTIX_INITIAL_PROMPT`, and records the session id on the event.
5. Saturate project provisioning sessions to the configured backpressure limit. **Assert** another valid fire returns `202 status='queued'`, inserts a queued event, and creates no branch/sandbox.

---

### 10.6 Auth boundary + concurrency tests

The positive tests above all use a single happy-path user. These tests exercise the parts that break when the system is actually multi-tenant.

#### 10.6.A Auth boundaries
- **Cross-account read**: alice creates project P1 in account A. Bob (account B, no membership in A) calls `GET /v1/projects/P1`. **Assert** `403`. Same for `/files`, `/files/content`, `/sessions`, `/sessions/:sid/sandbox`.
- **Cross-account proxy**: bob hits `/v1/p/<P1-sandbox-external-id>/8000/kortix/health`. **Assert** `403`.
- **Demoted user**: alice was a manager on P1, gets demoted to viewer. **Assert** subsequent `POST /v1/projects/P1/sessions` → `403`.
- **Removed user**: alice removes carol from account A. **Assert** carol's in-flight session proxy requests start returning `403` within ≤5s (token refresh cadence).
- **Invite enumeration**: anonymous + a different-email user both hit `GET /v1/account-invites/<id>`. **Assert** redacted shape; no leak of `account_name`, `inviter_email`, `email`.

#### 10.6.B Concurrency
- **Parallel session creates**: fire 10 × `POST /v1/projects/<id>/sessions` from the same user simultaneously. **Assert** 10 distinct UUIDs returned; 10 git branches pushed; 10 sandbox rows. No collisions. No "duplicate key" errors leaking.
- **Concurrent invite accepts**: two tabs accept the same invite. **Assert** exactly one succeeds (`200`), the other returns `200 { already_accepted: true }` — never two `account_members` rows.
- **Race on sandbox active**: while sandbox is in `provisioning`, the client polls + the API tries to PATCH it to `active`. **Assert** the row ends consistent (single writer wins, no partial-update artefact).
- **Cap enforcement**: user creates `N+1` concurrent sessions where N = their plan's cap. **Assert** the `(N+1)`th returns `429 { error: 'concurrent session limit' }`.

#### 10.6.C Performance budgets (SLOs)
- `POST /v1/projects/<id>/sessions` → 201: **p95 < 800ms** (excludes sandbox provisioning, only the synchronous write+push).
- Sandbox `provisioning` → `active`: **p95 < 45s** on daytona, **< 15s** on local_docker.
- `/v1/p/<ext>/8000/kortix/health`: **p95 < 250ms**.
- LLM router proxy overhead: **median < 60ms** added to upstream provider latency.
- Web `/projects` first paint: **p95 < 1.5s** authenticated.

When SLOs fail, file as a P1 even if no functional test breaks.

### 10.7 Failure modes (negative-space contract)

These should ALL hold; if any fail, the system is misbehaving even if no positive test fails.

| Behavior | Where it should NOT happen | Failure mode |
|---|---|---|
| `/instances/...` URL appears | While the user is on any `/projects/*` route | UI regression — middleware or hook bug |
| Bare `/sessions/<id>` URL | After clicking a chat in the sidebar inside a project session | The cookie kill-switch in `setActiveInstanceCookie` is broken |
| Active server snaps back to user's primary | Inside a project session | `useSandbox` autoSwitch guard is broken (`onProjectRoute` check) |
| Sandbox proxy returns 403 | When the caller is a member of the project's account | `preview-ownership` two-table lookup is broken |
| Session sandbox row in `kortix.sandboxes` | Always | Decoupling regression |
| Stale OpenCode sessions show in left rail | After clicking a session | Cache wipe on switch is broken |
| API banner shows `justavps` | Always | Provider whitelist regression |
| `POST /v1/projects/.../sessions { provider: 'justavps' }` returns 201 | Always | Provider whitelist regression |
| Legacy `/v1/platform/sandbox/list` returns project session sandboxes | Always | Cross-contamination |
| Right rail with Files/Terminal/Secrets renders on `/projects/.../sessions/...` | Always | `AppProviders showRightSidebar={false}` regression |

---

### 10.8 Running the suite

```sh
# API contract + E2E (against a running local stack)
cd apps/api && bun test tests/api/ tests/e2e/

# Web UI (chrome-devtools MCP today)
# Manual: navigate to each URL listed in §10.3, take snapshot, assert.

# Local stack smoke
pnpm dev               # API on :8008, web on :3000
curl http://localhost:8008/health      # → 200
curl http://localhost:3000             # → 200 (or 30x to /projects when authenticated)
```

A green run requires:
1. Every §10.2 endpoint returns its asserted status + shape.
2. Every §10.3 web flow completes without URL leaks to `/instances/` or `/dashboard`.
3. Every §10.5 E2E golden path completes (≤2 min each).
4. Every §10.6 auth boundary, concurrency, and SLO holds.
5. Every §10.7 failure mode is verifiably NOT happening.
6. `docs/production-runbook.md` has been rehearsed against staging for provider failure, Stripe failure, DB migration rollback, legacy migration rollback, sandbox image rollback, and API deploy rollback.

When any test in this section fails, **fix the system, not the spec.** The spec is the contract.

---

## 11. Decision log

Decisions made explicitly in this spec. Reverse only with cause.

| # | Decision | Alternative considered |
|---|---|---|
| 1 | OpenCode-native config format, no Kortix DSL | Custom `kortix.toml` DSL for agents/skills/etc. Rejected: forks the ecosystem, fights OpenCode upstream. |
| 2 | session_id == sandbox_id == branch name (one UUID) | Three separate IDs with mapping table. Rejected: needless complexity. |
| 3 | Secrets cloud-stored, env-var-injected at create-time | Encrypted in git. Rejected: rotation impossible without rewriting history. |
| 4 | LLM providers: single Kortix token + router proxy | Raw provider keys in sandbox env. Rejected: agents could exfiltrate via bash. |
| 5 | Connectors: same single-token + router pattern | Per-connector tokens in sandbox env. Rejected: same exfiltration risk. |
| 6 | Triggers: 100% cloud-side, sandbox never aware | Sandbox-side cron daemon. Rejected: triggers must outlive any single sandbox. |
| 7 | Memories v1: files in git | Cloud semantic store from day one. Rejected: premature; revisit when we have data. |
| 8 | Multiple sandbox providers, one daemon | Provider-specific images. Rejected: fragmentation. |
| 9 | Legacy `core/` deleted, cherry-pick from git as needed | Carry it forward as compat layer. Rejected: forever-debt. |
| 10 | Per-seat + per-compute cloud billing | Flat fee. Rejected: doesn't scale with usage. |
| 11 | LLM via single Kortix token + router proxy | **Ephemeral provider keys minted per session.** Rejected for v1: most providers don't support session-scoped minting; we lose usage tracking + provider abstraction. Documented as the fallback if router latency becomes the blocker. |
| 12 | GitHub PAT for `create-repo` | **GitHub App per account install.** Accepted as the production path; PAT is local/self-host fallback only when the app env is not configured. Repo create, branch push, and sandbox clone token source use the account installation. |
| 13 | Cloud OAuth proxy for self-host connectors | **Each customer registers their own OAuth apps.** Rejected for default v1: too much onboarding friction. Path B available as opt-in for air-gapped customers. |
| 14 | Daemon validates `X-Kortix-User-Context` via HMAC; port 8000 never publicly addressable | Trust-the-network. Rejected: a misconfigured Daytona preview or self-host port-forward would be full RCE on the agent. |
| 15 | Branch GC + sandbox idle hibernation | Unlimited retention. Rejected: GitHub branch count + Daytona meter both grow unboundedly. |
| 16 | `packages/` exists for cross-app deps only (db, shared); everything else inlines into apps | Flat `apps/`-only layout. Rejected: removes the physical barrier that keeps dependency direction one-way. |
| 17 | Audit log + OTel traces + usage events as three distinct streams | Single "events" table. Rejected: different retention/PII/access requirements; better as three sinks. |
| 18 | Web is the source-of-truth client for v1; mobile/desktop follow the web/API contract later | Keep mobile/desktop parity while the architecture is changing. Rejected: they currently preserve legacy assumptions and would drag them into v1. |
| 19 | `agent-tunnel` is either an intentional local-machine product surface or deleted together | Keep it as an accidental workspace package. Rejected: packages need independent lifecycle or multi-app use. |

---

## 12. Execution order

This is the current implementation order. It is allowed to change only when a dependency changes.

| Step | Work | Exit criterion | Production gate |
|---|---|---|---|
| A | Tree cleanup | No root scripts point at deleted `core/docker`; no empty packages remain without a named owner. | Gate 1 |
| B | Typecheck repair | `pnpm --filter kortix-api typecheck` and the focused web type/lint check for touched routes pass, or unrelated generated-doc failures are documented. | Gate 1 |
| C | Build sandbox image | `docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:dev .` succeeds. | Gate 2 |
| D | Daemon HMAC validation | Daemon rejects missing/invalid `X-Kortix-User-Context`; proxy path signs valid envelopes. | Gate 2 |
| E | E2E-1 by hand | First-time user creates project, creates session, reaches `/kortix/health`, and opens chat without `/instances`. | Gate 2 |
| F | §10.2/§10.3 tests | Account/project/session API tests and web smoke tests exist and pass against local stack. | Gate 3 |
| G | Project secrets + LLM router | Runtime secrets and provider keys stay cloud-side; sandbox only receives session-scoped tokens. | Gate 4 |
| H | GitHub App migration | Account installs GitHub App; repo creation uses installation token, not a human PAT. | Gate 4 |
| I | Branch GC + idle hibernation | Old session branches are swept by policy; idle sandboxes stop without losing Git-backed work. | Gate 4 |
| J | Billing correctness | Seat, compute, and LLM usage billing reconcile through Stripe with repeatable tests. | Gate 5 |
| K | Audit, usage, observability | State-changing writes emit audit events; router calls emit usage events; `GET /v1/ops/overview` and `/admin/ops` show API, sandbox, provider, queue, usage, audit, and migration health; managed logs + OTel trace propagation are either implemented or explicitly accepted as launch blockers. | Gate 5 |
| L | Rate limits and abuse controls | Account compute caps, router token buckets, invite throttles, and proxy caps are enforced and tested; webhook backpressure is completed with triggers. | Gate 5 |
| M | Migration tooling | `legacy_sandbox_migrations` journal + `migration:legacy-sandboxes` dry-run/apply/verify/rollback pass against local DB with fixed rollback evidence. | Gate 5 |
| N | Production E2E and runbook | §10 golden paths pass against a production-like stack; `docs/production-runbook.md` covers and has rehearsed provider failure, Stripe failure, DB migration rollback, legacy migration rollback, sandbox image rollback, and API deploy rollback. | Gate 5 |

Only Gate 5 means production-ready. Gates 1-4 are scaffolding and dependency closure toward production, not stopping points.

---

*Last updated: 2026-05-16 — Intended end state and production-readiness path added (§0), repo layout and product surfaces clarified (§2), GitHub App production path reflected (§3.2), session lifecycle + branch GC (§3.4), daemon trust model + refresh route (§3.5), secrets/LLM router/audit/usage/rate-limit implementation status updated (§5), connector token/MCP contract clarified (§3.9), ops dashboard status added (§3.16), migration compatibility line hardened (§7), test plan added (§10), decision log extended (§11), execution order and production runbook link added (§12), and Gate 5 runbook drill wording aligned with the six-drill release verifier.*

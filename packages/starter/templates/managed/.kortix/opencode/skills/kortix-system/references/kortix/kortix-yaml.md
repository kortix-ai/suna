# `kortix.yaml` — in-depth reference

`kortix.yaml` is the single source of truth for everything the
Kortix platform reads about a project. It lives at the repo root.
Any repo with a valid `kortix.yaml` (or, for legacy v1 projects, a
`kortix.toml`) at the root is a Kortix project.

The platform parser is permissive: it never throws on a bad entry.
Instead, bad triggers go into an `errors` list returned alongside the
good ones, so a single typo doesn't break the whole file.

This page documents `kortix_version: 2`, which uses OpenCode REST and a
governance-only `agents:` name-to-block map.

The authoritative structural spec is the public JSON Schema:
`https://kortix.com/schema/kortix.v2.schema.json`, or
`https://kortix.com/schema/kortix.schema.json` for all published versions.
Use `kortix schema --version 2` offline.

> **Legacy note — v1 used TOML.** Projects created before v2 shipped
> may still have a `kortix.toml` at the root with `kortix_version: 1`
> (or no `kortix_version` at all). The platform resolves the manifest
> by trying `kortix.yaml`, then `kortix.yml`, then falling back to
> `kortix.toml` — so a v1 TOML project keeps working as-is; nothing
> breaks. To move a project onto v2, rename `kortix.toml` to
> `kortix.yaml`, convert its contents to YAML, bump `kortix_version` to
> `2`, add the now-required `default_agent`, and rework any `[[agents]]`
> array into the `agents:` map described below (or run `kortix migrate`
> once available). `kortix_version: 2` manifests must be YAML — TOML
> only supports `kortix_version: 1`.

## Version 2 example

```yaml
# yaml-language-server: $schema=https://kortix.com/schema/kortix.v2.schema.json
kortix_version: 2

default_agent: kortix

project:
  name: my-project
  description: What this project is.

# Env vars the runtime needs. `required` is *advisory* — surfaced in
# the dashboard so the user knows what to set, but not enforced at
# session start.
env:
  required:
    - DATABASE_URL
  optional:
    - STRIPE_API_KEY
    - WEBHOOK_SLACK_SECRET

# Named sandbox environments. Each template uses one image or Dockerfile.
sandbox:
  default: ml
  templates:
    - slug: ml
      name: ML
      dockerfile: .kortix/Dockerfile

# OpenCode runtime config dir. Defaults to ".kortix/opencode" when
# omitted. The agent daemon launches opencode with
# OPENCODE_CONFIG_DIR pointed here. OpenCode-native runtime config
# remains in this directory; Kortix-side launchability and grants live
# in the `agents:` map below.
opencode:
  config_dir: .kortix/opencode

# ─── Apps ─────────────────────────────────────────────────────────
# Local, repeatable deployment defaults. `kortix apps deploy` remains the
# explicit deployment action; merging this file does not auto-deploy.
apps:
  storefront:
    path: web
    type: bundle
    output_dir: dist
    readiness_path: /
    idle_timeout_seconds: 300
    monthly_budget_usd: 5
    resources:
      cpu: 1
      memory_gb: 2
      disk_gb: 10
    env:
      NODE_ENVIRONMENT: production
    secrets:
      DATABASE_URL: database-primary

# ─── Triggers ─────────────────────────────────────────────────────
# Each `triggers:` entry spawns a fresh session that runs `prompt`
# as its initial message. Slugs must be lowercase URL-safe and
# unique among triggers.
triggers:
  - slug: daily-digest
    name: Daily digest
    type: cron
    agent: kortix
    enabled: true
    cron: "0 0 9 * * 1-5"            # 09:00 Mon–Fri
    timezone: America/Los_Angeles
    prompt: |
      Summarize yesterday's commits across the repo. Save the result to
      notes/digest-{{ fired_at }}.md and open a CR against main.

  - slug: slack-hook
    name: Slack handler
    type: webhook
    agent: kortix
    enabled: true
    secret_env: WEBHOOK_SLACK_SECRET   # add value via Secrets Manager
    prompt: |
      Slack event from {{ headers.user_agent }}.
      User said: {{ body.text }}

# ─── Agents (governance only) ─────────────────────────────────────
agents:
  kortix:
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
  release-bot:
    sandbox: ml
    connectors: [github]
    kortix_permissions: [project.write, project.cr.open]    # may OPEN a CR, but not merge it
```

## `agents:` in version 2

Per-agent **governance overlay**. OpenCode-native behavior (prompt, mode,
model, tools, permissions, skills selection logic) stays in
`.kortix/opencode/` and `opencode.jsonc`; the manifest's `agents:` map
declares which agents Kortix should treat as platform-launchable and
what server-side authority each one receives. Keyed by the agent's name
(matches its `.kortix/opencode/agents/<name>.md`).

`agents:` is **required** in v2 and is **deny-by-default**: an omitted
`connectors`/`secrets`/`skills`/`kortix_permissions` on a declared agent
resolves to `none`, not `all`. `default_agent` is also required and
must name a declared, enabled agent.

| Key          | Notes                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `enabled`    | Whether the platform may launch this agent. Default: `true`.                                     |
| `sandbox`    | Sandbox template for this agent. Must name an available template or `default`.                  |
| `connectors` | Connectors the agent may call. `["slug", …]` \| `"all"` \| `"none"` (default: `none`).           |
| `secrets`    | Env-var / secret names the agent may read. Same shape (default: `none`).                        |
| `skills`     | Skill names the agent may load. Same shape (default: `none`).                                   |
| `kortix_permissions` | Kortix permissions: what it may do to the project (project-scoped iam actions), through the CLI, the API, or git. Same shape (default: `none`). `kortix_cli` is the deprecated spelling — still accepted with a validation warning. |
| `workspace`  | `"runtime"` \| `"read"` \| `"branch"` — the git workspace mode granted to the agent.              |
| `apps`       | Restricted or private Apps this agent may open, by slug. `["slug", …]` \| `"all"` \| `"none"` (default: `none`). The App gate also requires `project.app.read` in the agent's effective permissions. Editable from Customize → Agents → the agent → Apps, or `kortix agents scope <agent> --apps <slug,slug>`. |

```yaml
agents:
  release-bot:
    sandbox: ml
    connectors: [github]
    kortix_permissions: [project.write, project.cr.open]    # may OPEN a CR, but not merge it
```

**Grantable `kortix_permissions`** (project-scoped only — account-level admin
actions can never be granted to an agent; `project.members.manage`,
`project.delete` and `project.credentials.issue` are HUMAN_ONLY and never
effective for an agent; run `kortix validate --scopes`):
`project.read|write|delete`, `project.cr.open|merge`,
`project.session.read|start|stop|bindings.write`, `project.members.read|manage`,
`project.trigger.read|create|update|delete|fire`,
`project.connector.read|write|connections.manage`
(channels — Slack/meet/email send + connect — are gated on `project.connector.write`).

**Resolution at session start:** every agent must be declared under
`agents:`; an undeclared or disabled agent cannot be launched by the
platform. `default_agent` must resolve to a declared, enabled agent —
give it `connectors: all`, `secrets: all`, `kortix_permissions: all`,
`skills: all` explicitly if it should keep full access. The grant
takes effect only once a CR is merged (read from the default branch).
The agent is the acting principal: `kortix_permissions` ∩ its ceiling role
(IAM, bound to the agent's service account; default = every grantable
permission) − the HUMAN_ONLY set. The launcher's role is not an input; the
launcher only needs "may run this agent".

**Discovery direction:** declaring `agents:` is server-side, declarative
agent discovery — it is not a rule that every native OpenCode agent file
must be registered. Unregistered files can exist for local experiments
or runtime internals. Kortix product UI (chat input, triggers, channels)
fetches the server-side registered agent list rather than querying
sandbox OpenCode directly. Model pickers similarly come from the
server/LLM-gateway catalog rather than a sandbox-local provider list.

## `connectors:`

An optional list of connector definitions — the external systems agents call
as tools (Composio apps, MCP servers, OpenAPI/Postman/GraphQL/HTTP endpoints,
channels). Mirrors the dashboard's Customize → Connectors. Connectors are
project-wide visible; the only access gate is which agents may call one
(`agents.<name>.connectors` above).

```yaml
connectors:
  # Managed SaaS app via Composio — OAuth/API handled by Composio
  - slug: gmail
    provider: composio
    name: Gmail
    app: gmail

  # Generic REST API from an OpenAPI spec, shared API-key credential
  - slug: smartlead
    provider: openapi
    name: SmartLead API
    spec: .kortix/smartlead.openapi.json     # repo path or URL
    credential: shared
    auth:
      type: custom                           # bearer|basic|api_key|custom|hmac|…
      in: query
      name: api_key
    policies:
      - match: "*"                           # action path or wildcard
        action: always_run                   # always_run|require_approval|block

  # Built-in channel connector (one-click install link, e.g. Slack)
  - slug: kortix_slack
    provider: channel
    platform: slack
```

| Field                   | Required | Notes                                                                                              |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `slug`                  | yes      | `[a-z0-9][a-z0-9_-]{0,127}`, unique among connectors (and apps).                                      |
| `provider`              | yes      | `composio` \| `openapi` \| `mcp` \| `graphql` \| `http` \| `postman` \| `channel` \| `pipedream` (legacy rollback only — never select it automatically). |
| `app`                   | composio | The Composio toolkit slug (e.g. `gmail`, `linear`). Find one: `kortix connectors apps <query>`.      |
| `spec`                  | openapi/postman | URL or repo-relative path to the spec.                                                       |
| `url` + `transport`     | mcp      | MCP server URL; transport `http` (default) or `sse`.                                                |
| `endpoint`              | graphql  | GraphQL endpoint URL.                                                                               |
| `base_url`              | http     | HTTP base URL.                                                                                      |
| `name`                  | no       | Human display name (also set live with `kortix connectors rename`).                                  |
| `platform`              | channel  | `slack` \| `teams` \| `email`.                                                                       |
| `credential`            | no       | `shared` — one server-side credential for the connector. Set the value via `kortix connectors credential` or bind a project secret (`kortix connectors secret`). Never inline in the manifest. |
| `auth`                  | no       | How the credential is applied: `type` plus placement (`in: header\|query` + `name`).                  |
| `policies`              | no       | Per-action risk policy: `{ match, action }`. `match` is an action path or wildcard.                  |
| `authorization_strategy`| no       | **Deprecated — do not use.** Kept on the wire and in the parser, but nothing reads it server-side. Ownership is a per-CONNECTION property (see below), not a connector setting. |

Adding/removing entries: `kortix connectors add <slug> --provider <p> …` /
`kortix connectors rm <slug>` edit the local file (add `--apply` to commit to
main + sync instantly, like the dashboard); plain edits need `kortix ship` then
`kortix connectors sync`.

### Connector accounts: project-shared vs member-private

A connector is a project-wide TOOL, but the ACCOUNT it runs as is bound when
the human authorizes it, and that account is either:

- **Project-shared** (`owner: project`) — one identity the WHOLE project acts
  as; every member's and every agent session's calls run as it (the default
  account for unnamed calls). This is the right choice for shared company tools.
- **Member-private** (`owner: me`) — bound to the one person who authorized it;
  reachable only by that person inside a private session — never by a service
  account or an unattended automation (the `--account me` selector).

**The identity that completes the OAuth is the identity the connector acts
as.** A project-shared account must therefore be authorized under the
project's own shared identity (a team or service account the project owns)
— **never a personal login**. A personal login in the shared slot means every
agent session (support, sales, engineering) silently acts AS that person:
their inbox, their calendar, their Linear identity, their files.

Rules:

- Shared company tool (company inbox / calendar / Linear / Docs) →
  `kortix connectors connect <slug> --owner project`, and the human completes
  the OAuth **signed in as the project identity**.
- A person's own login → `kortix connectors connect <slug> --owner me`.
- Ambiguous? Ask the human. Never silently default a personal login into the
  shared slot.
- With several accounts on one connector and none named or pinned, calls are
  DENIED (`account_required`) rather than guessed — pin one explicitly:
  `kortix connectors accounts <slug> --default <label>`.

> **History note:** the manifest once had an `authorization_strategy:
> project|user` field that made the two owner types mutually exclusive per
> connector. It is retired (the manifest parser still accepts it, but nothing
> reads it) — and it was itself the cause of this bug class: a `user`-strategy
> connector had NO connect flow anywhere, because three call sites refused
> anything that wasn't `project`, which pushed people into authorizing
> personal logins into the shared slot. Ownership now lives on each
> connection row; do not reach for the old field.

**`connected_as` is how you catch a mis-scoped account without guessing.** A
label is chosen before authorization, so `label: "Support inbox"` says nothing
about which login actually completed the OAuth. `connected_as` does: Kortix
reads the provider's own identity (the connected account's display name, or a
per-toolkit "who am I" call) when authorization finalizes, and shows it as a
`CONNECTED AS` column in `kortix connectors accounts <slug>` and
`kortix connectors connections ls`. A generic default label is replaced by that
identity automatically; a label a human chose is left alone (rename it without
re-authorizing with `kortix connectors connections rename <connection-id>
<label…>`). Read `connected_as` on the project-shared account before you trust
it — if it shows a person's email instead of the project identity, that
account is mis-scoped and needs the fix below.

The invariant that matters, now enforced per row: **an unattended automation
(trigger, cron, webhook, any service-account session) can NEVER run as a
member-private account** — a `member`-owned connection is reachable only by
its owner inside a private session, and never by a service account. So shared
automations use the project-shared account, which is exactly why that slot
must hold the project identity and not someone's personal login.

**Fixing a connector mis-scoped to a personal login** (find it by reading
`CONNECTED AS` in `kortix connectors accounts <slug>` and the manage-gated
roster `kortix connectors connections ls --all`):

1. Mint a fresh shared link — `kortix connectors connect <slug> --owner
   project` — and have a human complete the OAuth **as the project identity**.
2. Pin it: `kortix connectors accounts <slug> --default <label>`.
3. Revoke the stray personal binding: `kortix connectors connections revoke
   <connection-id>`.
4. Optionally re-add the person's own account with `--owner me` so they keep
   private access from their own sessions.

There is no in-place owner change — an account's owner is fixed at
authorization. Re-scoping always means: authorize-new → re-pin → revoke-old.

## Schema versioning

`kortix_version` is the schema version. Version 2 is YAML-only and requires
`default_agent` and `agents`.

A manifest declaring a version higher than
the platform knows about is rejected outright — the platform won't
silently misread future fields.

When the platform writes the manifest back (after a dashboard edit),
it ensures `kortix_version` is the first key, so the file is
self-describing at a glance.

## What's parsed where

| Surface                | What it reads                                                       |
| ---------------------- | ------------------------------------------------------------------- |
| Trigger sweep          | `triggers:`                                                          |
| Sandbox builder        | `sandbox:`                                                           |
| Sandbox runtime        | v2 `opencode:`                                                   |
| Session bootstrap      | `env:` (advisory — surfaced to dashboard, not enforced)              |
| Apps CLI               | `apps:` (local deployment defaults; deploy remains explicit)          |
| Session token mint     | `agents:` (per-agent connectors/secrets/skills/apps/kortix_permissions scope) |
| Connector catalog      | `connectors:` (definitions; account ownership is cloud-side)         |
| Agent/model UI         | Server-side agent registry + LLM-gateway model catalog                |
| Dashboard UI           | All of the above + `project:` + the raw manifest                     |

Every surface above reads the MERGED manifest when the root declares
`imports:` (see below). `sandbox:`, `opencode:`, `env:`, `project:`,
`default_agent`, and `runtime` are root-only keys.

Unknown top-level keys are ignored — safe to add your own metadata,
but the platform won't react to it.

## `imports:` — split the manifest across files

Use it when `kortix.yaml` outgrows one screen (many triggers with long
prompts, one file per team or agent group). Do not dump 30 triggers into
the root file.

```yaml
# kortix.yaml
kortix_version: 2
default_agent: kortix
imports:
  - .kortix/triggers/        # a directory: every .yaml/.yml below it, any depth
  - .kortix/agents.yaml      # a single file
agents:
  kortix:
    connectors: all
```

```yaml
# .kortix/triggers/reports/weekly.yaml
triggers:
  - slug: weekly-report
    type: cron
    agent: galileo
    cron: "0 0 15 * * 0"
    prompt: |-
      Build the weekly report.
```

The platform merges the root and every import into one manifest before
it validates, sweeps triggers, or mints agent grants. A trigger in one
file can name an agent declared in another.

Rules:

- Paths are relative to the repository root. No `..`, no absolute
  paths, no globs.
- A directory import takes every `.yaml`/`.yml` below it, sorted by path.
- An imported file declares only `triggers`, `connectors`, `agents`,
  `apps`, and `imports` (nesting: max 8 levels, 200 files). Every other
  key stays in `kortix.yaml`; an imported file that sets one is an error.
- One name, one file. The same trigger/connector slug or agent/app name
  in two files is an error naming both files. Nothing overrides silently.
- A broken import fails the WHOLE manifest, like a YAML syntax error.
  Run `kortix validate` before `kortix ship`; it checks the merged result.
- Dashboard, API, and `kortix triggers enable|disable|rm` edits are
  written to the file that declares the entry. A new entry created
  through the API lands in `kortix.yaml`; move it by hand if you want it
  in an imported file.

## `project:`

Project metadata for the dashboard.

| Key           | Required | Notes                                |
| ------------- | -------- | ------------------------------------ |
| `name`        | yes      | Display name. Shown in the UI.       |
| `description` | no       | One-liner shown beside the name.     |

## `env:`

Declares the env vars your sessions need. The values themselves live
in the **Kortix Secrets Manager** — never inline.

| Key         | Type        | Notes                                                                                    |
| ----------- | ----------- | ---------------------------------------------------------------------------------------- |
| `required`  | `string[]`  | Advisory list — surfaced in the dashboard. Not enforced at session-start today.          |
| `optional`  | `string[]`  | Available to sessions if set; absence is fine.                                           |

**Heads-up on enforcement:** the dashboard uses `required` to nag
the user about secrets to set, but the session bootstrap doesn't
currently block on missing values. Treat `required` as a contract
with the user, not the platform.

**Name validation in the manifest** is permissive: items must match
`^[A-Z_][A-Z0-9_]*$` (no length cap). The Secrets Manager API
itself caps secret names at 64 chars (`^[A-Z_][A-Z0-9_]{0,63}$`) —
so a long name in the manifest will be accepted, but the user can't
actually create the matching secret. Keep names ≤ 64 chars.

**`KORTIX_*` is only reserved at the Secrets Manager surface**, not
at manifest parse time. The dashboard rejects creating secrets with
that prefix, but you can list `KORTIX_FOO` in `env:` without an
error from the parser. Don't — it'll just never have a value.

## `sandbox:`

Sandbox templates and the project default. The whole section is optional.
Omission selects the platform `default` template.

| Key | Default | Notes |
| --- | --- | --- |
| `default` | `default` | Declared template slug or reserved platform `default`. |
| `templates` | `[]` | Named image or Dockerfile templates. |

### `sandbox.templates`

Optional named alternate sandbox images/Dockerfiles a trigger or
session can select instead of the project default.

```yaml
sandbox:
  templates:
    - slug: gpu-worker
      name: GPU worker
      dockerfile: .kortix/Dockerfile.gpu
      cpu: 4
      memory: 16
    - slug: browser-test
      name: Browser testing
      image: mcr.microsoft.com/playwright:v1.45.0
```

Each entry needs exactly one of `image` or `dockerfile`, never both.
`slug` may not be `"default"` (that's reserved for the top-level
`sandbox:` config).

Session template precedence is explicit `sandbox_slug`, agent `sandbox`,
project `sandbox.default`, then platform `default`. Triggers, schedules, and
channels use the target agent's template.

## `opencode:` in version 2

Where the OpenCode runtime config lives. **Optional**, with a default.

| Key          | Default              | Notes                                                                            |
| ------------ | --------------------- | -------------------------------------------------------------------------------- |
| `config_dir` | `.kortix/opencode`   | Repo-relative dir. Same silent-fallback behavior as `sandbox:` paths.            |

The agent daemon launches `opencode serve` with
`OPENCODE_CONFIG_DIR=<config_dir>`, so everything under that folder
becomes the OpenCode runtime: agents, skills, commands, tools, plugins,
`opencode.jsonc`.

`opencode.jsonc` remains the OpenCode-native registry for plugins, MCP servers,
providers, model/provider settings, permissions, and default runtime behavior.
Do not duplicate those details in `kortix.yaml`; use `agents:` only for the
Kortix-side decision of which agents are launchable/authorized by the platform.

## `triggers:`

A list. Each entry is a trigger that spawns a fresh session
on fire. Triggers are sorted alphabetically by slug in the parsed
output — UI ordering is stable, not authoring-order.

### Common fields

| Field        | Required | Type    | Default     | Notes                                                          |
| ------------ | -------- | ------- | ----------- | -------------------------------------------------------------- |
| `slug`       | yes      | string  | —           | `[a-z0-9][a-z0-9_-]{0,127}`, unique among triggers.            |
| `type`       | yes      | string  | —           | `"cron"` or `"webhook"`.                                       |
| `prompt`     | yes      | string  | —           | Mustache-style template.                                      |
| `name`       | no       | string  | `slug`      | Human label.                                                   |
| `agent`      | no       | string  | `default_agent` | Must name a declared agent in `agents:`.                  |
| `enabled`    | no       | bool    | `true`      | Accepts strings: `"true"/"false"/"yes"/"no"/"on"/"off"/"1"/"0"`. |
| `session_mode` | no     | string  | `"fresh"`   | `"fresh"` (new session every fire, no prior history) or `"reuse"` (re-prompts the same long-lived session, resuming its sandbox and accumulated context). See `<scheduling>` in this skill's SKILL.md for when to pick each. |

The parser accepts only the canonical trigger field names shown here.

**Slug uniqueness is per-section.** A trigger and an app may share
a slug; two triggers may not.

### Cron-only fields

| Field      | Required | Type    | Default | Notes                                                       |
| ---------- | -------- | ------- | ------- | ----------------------------------------------------------- |
| `cron`     | yes      | string  | —       | 6-field croner expression: `second minute hour day month weekday`. |
| `timezone` | no       | string  | `"UTC"` | IANA name, e.g. `"America/Los_Angeles"`.                    |

The platform polls every 60 s by default
(`KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS`), so sub-minute precision is
best-effort.

### Webhook-only fields

| Field        | Required | Type    | Notes                                                                                  |
| ------------ | -------- | ------- | -------------------------------------------------------------------------------------- |
| `secret_env` | yes      | string  | Name of a `project_secrets` entry holding the HMAC secret. Manifest-side regex is `^[A-Z_][A-Z0-9_]*$` (unbounded). |

Webhooks fire on signed POSTs to:

```
POST /v1/webhooks/projects/<project_id>/<slug>
```

#### Signature

- Primary header: `X-Kortix-Signature: sha256=<hmac>`. The `sha256=`
  prefix is optional — the receiver strips it if present.
- GitHub-compatible: `X-Hub-Signature-256` is also accepted, so
  GitHub webhooks point straight at this URL with no adapter.
- Algorithm: HMAC-SHA256 over the **raw** request body using the
  secret named by `secret_env`.
- Format: exactly 64 hex chars (mixed case accepted).
- Compared with constant-time `timingSafeEqual`.

#### Response codes

| Status | Meaning                                                  |
| ------ | -------------------------------------------------------- |
| 200    | Signature valid, session queued.                          |
| 401    | Signature missing or mismatched.                          |
| 404    | Trigger not found, disabled, or not a webhook.           |
| 409    | `secret_env` value is not configured in Secrets Manager. |

### Prompt template variables

The `prompt` field is rendered with a small mustache-style engine:
`{{ token.dotted.path }}`. Missing values render as empty strings —
no error, no `{{ x }}` left in the output. Objects/arrays render as
JSON.

Variables available on every fire:

| Variable             | Source                                                         |
| -------------------- | -------------------------------------------------------------- |
| `{{ trigger.slug }}` | The trigger's slug.                                            |
| `{{ trigger.type }}` | `"cron"` or `"webhook"`.                                       |
| `{{ trigger.kind }}` | Always `"git"` for manifest-defined triggers.                  |

Cron-only additions. There is **no** `fired_at` on a cron fire — use
`cron.scheduled_for`:

| Variable                        | Source                                        |
| ------------------------------- | --------------------------------------------- |
| `{{ cron.schedule }}`           | The croner expression that just fired.        |
| `{{ cron.timezone }}`           | Configured tz (defaults to `"UTC"`).          |
| `{{ cron.scheduled_for }}`      | The slot this fire is for (ISO-8601).         |
| `{{ cron.claimed_at }}`         | When the scheduler picked the slot up.        |
| `{{ cron.last_scheduled_for }}` | The previous slot; empty on the first fire.   |

Webhook-only additions:

| Variable          | Source                                                          |
| ----------------- | ----------------------------------------------------------------- |
| `{{ fired_at }}`  | ISO-8601 timestamp of this fire. Webhook and manual fires only.  |
| `{{ body.* }}`    | JSON-parsed request body. Dotted access works.                  |
| `{{ headers.* }}` | `content_type`, `user_agent`, `forwarded_for`.                  |

### Runtime state

Manifest is the source of truth for **config**. The
`project_trigger_runtime` table is the source of truth for **state**
(`last_fired_at`, `event_count`). Writing to the repo on every fire
would amplify the scheduler tick into a flood of git commits.
If you need to know when a trigger last fired, check the dashboard,
not the repo.

### Project-wide kill switch

There is no "paused" state for a single trigger — only `enabled`
on/off, or removing the entry entirely. Separately, the **project**
has a server-side kill-switch, `triggers_paused`, toggled from the
dashboard: when set, the sweep skips *every* trigger on the project
and inbound webhooks are ignored, regardless of each trigger's own
`enabled`. Use it when the same repo is deployed to two environments
and only one should actually fire.

### Common gotchas

- `triggers:` must be a **list** (`- slug: …`), not a map — the parser
  surfaces a clear error otherwise. The same holds in an imported file.
- A slug must be unique across `kortix.yaml` AND every imported file. A
  duplicate is not a per-entry error: it fails the whole manifest, and no
  trigger fires until it is fixed. `kortix validate` names both files.
- Slugs must be lowercase + URL-safe. Uppercase or spaces fail.
- A webhook trigger without `secret_env` is rejected.
- A cron trigger without a `cron` expression is rejected.
- Bad entries surface in `errors` next to the good ones — they don't
  break the whole file.

## Secrets

Per-project, encrypted at rest. The platform uses **AES-256-GCM** with
**HKDF-derived per-project keys** rooted in the platform's
`API_KEY_SECRET`. Stored in the `project_secrets` table; **never
inline in the repo**.

### Flow

1. Declare the secret name under `env:`:
   ```yaml
   env:
     required:
       - DATABASE_URL
     optional:
       - STRIPE_API_KEY
       - WEBHOOK_SLACK_SECRET
   ```
2. Set the value in the Kortix Secrets Manager (dashboard).
3. When a session boots, the platform decrypts every secret on the
   project and injects them as plain env vars into the sandbox.
4. Your agent code reads them like any other env var.

### Rules

- Names in the Secrets Manager match `^[A-Z_][A-Z0-9_]{0,63}$`.
- `KORTIX_*` is reserved **at the Secrets Manager surface** — the
  CRUD endpoint rejects it. The manifest parser does not enforce
  this; declaring `KORTIX_FOO` in `env:` is accepted but no matching
  secret can be created.
- Webhook triggers reference signing secrets by env-var name only
  (`secret_env: WEBHOOK_FOO_SECRET`). The value is resolved at
  fire-time — the manifest never sees the plaintext.
- Mid-session rotation: secrets come in at sandbox-create time.
  Rotating a key in the dashboard takes effect on the **next**
  session.

## Editing the manifest

The manifest round-trips through the dashboard. When editing in a
session, keep entries in the same shape the platform writes them
back in (slug, name, type, agent, enabled, then type-specific fields,
then `prompt` last). This avoids needless diffs when the user later
edits the same trigger from the UI.

If you add a new trigger and don't yet have a value for `secret_env`,
declare it in `env.optional` so it shows up in the Secrets Manager,
and leave the trigger `enabled: false` until the user sets the value.

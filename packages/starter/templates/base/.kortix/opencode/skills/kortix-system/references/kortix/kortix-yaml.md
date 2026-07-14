# `kortix.yaml` — in-depth reference

`kortix.yaml` is the single source of truth for everything the
Kortix platform reads about a project. It lives at the repo root.
Any repo with a valid `kortix.yaml` (or, for legacy v1 projects, a
`kortix.toml`) at the root is a Kortix project.

The platform parser is permissive: it never throws on a bad entry.
Instead, bad triggers go into an `errors` list returned alongside the
good ones, so a single typo doesn't break the whole file.

**This page documents `kortix_version: 2`** — the current, YAML-only
manifest schema (`agents:` is a governance-only name→block **map**,
`[[channels]]` is removed outright, per-agent env access is called
`secrets`). This project's own `kortix.yaml` is on this version — see
the `<canonical-schema>` section of this skill's `SKILL.md` and
`docs/specs/2026-07-05-agent-first-config-unification.md`. The
authoritative, always-current structural spec is always the public
JSON Schema, not this page: `https://kortix.com/schema/kortix.v2.schema.json`
(this shape), `https://kortix.com/schema/kortix.v1.schema.json` (legacy
v1), or `https://kortix.com/schema/kortix.schema.json` (both,
dispatched by `kortix_version`) — also available offline via
`kortix schema --version 2`.

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

## Full example

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

# Sandbox base image. Sessions run from a snapshot built off this
# Dockerfile. Both paths default to ".kortix/Dockerfile" / "." when
# omitted — declaring them just makes the intent explicit.
sandbox:
  dockerfile: .kortix/Dockerfile   # repo-relative
  context: .                       # build context

# OpenCode runtime config dir. Defaults to ".kortix/opencode" when
# omitted. The agent daemon launches opencode with
# OPENCODE_CONFIG_DIR pointed here. OpenCode-native runtime config
# remains in this directory; Kortix-side launchability and grants live
# in the `agents:` map below.
opencode:
  config_dir: .kortix/opencode

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
    kortix_cli: all
    skills: all
  release-bot:
    connectors: [github]
    kortix_cli: [project.write, project.cr.open]    # may OPEN a CR, but not merge it
```

## `agents:`

Per-agent **governance overlay**. OpenCode-native behavior (prompt, mode,
model, tools, permissions, skills selection logic) stays in
`.kortix/opencode/` and `opencode.jsonc`; the manifest's `agents:` map
declares which agents Kortix should treat as platform-launchable and
what server-side authority each one receives. Keyed by the agent's name
(matches its `.kortix/opencode/agents/<name>.md`).

`agents:` is **required** in v2 and is **deny-by-default**: an omitted
`connectors`/`secrets`/`skills`/`kortix_cli` on a declared agent
resolves to `none`, not `all`. `default_agent` is also required and
must name a declared, enabled agent.

| Key          | Notes                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `enabled`    | Whether the platform may launch this agent. Default: `true`.                                     |
| `connectors` | Connector profiles the agent may call. `["slug", …]` \| `"all"` \| `"none"` (default: `none`).   |
| `secrets`    | Env-var / secret names the agent may read. Same shape (default: `none`).                        |
| `skills`     | Skill names the agent may load. Same shape (default: `none`).                                   |
| `kortix_cli` | What it may do via the Kortix CLI/API (project-scoped iam actions). Same shape (default: `none`). |
| `workspace`  | `"runtime"` \| `"read"` \| `"branch"` — the git workspace mode granted to the agent.              |

```yaml
agents:
  release-bot:
    connectors: [github]
    kortix_cli: [project.write, project.cr.open]    # may OPEN a CR, but not merge it
```

**Grantable `kortix_cli` actions** (project-scoped only — account-level admin
actions can never be granted to an agent; run `kortix validate --scopes`):
`project.read|write|delete`, `project.cr.open|merge`,
`project.session.read|start|stop|bindings.write`, `project.members.read|manage`,
`project.trigger.read|create|update|delete|fire`,
`project.connector.read|write|profiles.manage`
(channels — Slack/meet/email send + connect — are gated on `project.connector.write`).

**Resolution at session start:** every agent must be declared under
`agents:`; an undeclared or disabled agent cannot be launched by the
platform. `default_agent` must resolve to a declared, enabled agent —
give it `connectors: all`, `secrets: all`, `kortix_cli: all`,
`skills: all` explicitly if it should keep full access. The grant is
always intersected with the launching user's role (agent ≤ user) and
takes effect only once a CR is merged (read from the default branch).

**Discovery direction:** declaring `agents:` is server-side, declarative
agent discovery — it is not a rule that every native OpenCode agent file
must be registered. Unregistered files can exist for local experiments
or runtime internals. Kortix product UI (chat input, triggers, channels)
fetches the server-side registered agent list rather than querying
sandbox OpenCode directly. Model pickers similarly come from the
server/LLM-gateway catalog rather than a sandbox-local provider list.

## Schema versioning

`kortix_version` is the schema version. `2` is YAML-only and requires
`default_agent` + `agents:`. A manifest declaring a version higher than
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
| Sandbox runtime        | `opencode:` (where to launch opencode with its config)               |
| Session bootstrap      | `env:` (advisory — surfaced to dashboard, not enforced)              |
| Session token mint     | `agents:` (per-agent connectors/secrets/skills/kortix_cli scope)     |
| Agent/model UI         | Server-side agent registry + LLM-gateway model catalog                |
| Dashboard UI           | All of the above + `project:` + the raw manifest                     |

Unknown top-level keys are ignored — safe to add your own metadata,
but the platform won't react to it.

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

Sandbox base image **and hardware spec**. **Entirely optional.** Omitting
the key (or any sub-key) falls back to defaults.

| Key          | Default               | Notes                                                                                  |
| ------------ | --------------------- | -------------------------------------------------------------------------------------- |
| `dockerfile` | `.kortix/Dockerfile`  | Repo-relative path. Aliases: none.                                                     |
| `context`    | `.`                   | Build context, repo-relative. Alias: `context_dir`.                                    |
| `cpu`        | provider default      | vCPU cores. Alias: `cpus`.                                                             |
| `memory`     | provider default      | RAM in GiB. Aliases: `memory_gb`, `mem`.                                              |
| `disk`       | provider default      | Disk in GiB. Alias: `disk_gb`.                                                        |
| `gpu`        | provider default (none) | GPU units. Requires GPU capacity on the runtime.                                     |

Both paths must be repo-relative. **Absolute paths and `..` traversal
are silently ignored** — the validator falls back to the default
without surfacing an error. If your custom path "isn't being read",
this is the usual cause.

The hardware spec (`cpu`/`memory`/`disk`/`gpu`) is **baked into the
snapshot**, so changing any value rebuilds the image and takes effect on
the **next** session — same as a Dockerfile edit. Values round to whole
numbers; non-positive values fall back to the default and values above
the platform ceiling (cpu 32, memory 128, disk 500, gpu 8) clamp down.

See the runtime / layered-build documentation for how the snapshot
builder appends the Kortix runtime layer on top of your image.

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

## `opencode:`

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
| `{{ fired_at }}`     | ISO-8601 timestamp of this fire.                               |
| `{{ trigger.slug }}` | The trigger's slug.                                            |
| `{{ trigger.type }}` | `"cron"` or `"webhook"`.                                       |
| `{{ trigger.kind }}` | Always `"git"` for manifest-defined triggers.                  |

Cron-only additions:

| Variable                | Source                                  |
| ----------------------- | ---------------------------------------- |
| `{{ cron.schedule }}`   | The croner expression that just fired.  |
| `{{ cron.timezone }}`   | Configured tz (defaults to `"UTC"`).    |
| `{{ cron.fired_at }}`   | Same as top-level `fired_at`.           |
| `{{ cron.last_fired_at }}` | Previous fire timestamp (or empty).  |
| `{{ last_fired_at }}`   | Same as `cron.last_fired_at`.           |

Webhook-only additions:

| Variable          | Source                                                          |
| ----------------- | ----------------------------------------------------------------- |
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
  surfaces a clear error otherwise.
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

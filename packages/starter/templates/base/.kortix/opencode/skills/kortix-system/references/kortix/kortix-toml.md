# `kortix.toml` — in-depth reference

`kortix.toml` is the single source of truth for everything the
Kortix platform reads about a project. It lives at the repo root.
Any repo with a valid `kortix.toml` at the root is a Kortix project.

The platform parser is permissive: it never throws on a bad entry.
Instead, bad triggers and apps go into an `errors` list returned
alongside the good ones, so a single typo doesn't break the whole
file.

## Full example

```toml
# Pinned schema version. Lets the platform evolve safely.
kortix_version = 1

[project]
name = "my-project"
description = "What this project is."

# Env vars the runtime needs. `required` is *advisory* — surfaced in
# the dashboard so the user knows what to set, but not enforced at
# session start.
[env]
required = ["DATABASE_URL"]
optional = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "WEBHOOK_SLACK_SECRET"]

# Sandbox base image. Sessions run from a snapshot built off this
# Dockerfile. Both paths default to ".kortix/Dockerfile" / "." when
# omitted — declaring them just makes the intent explicit.
[sandbox]
dockerfile = ".kortix/Dockerfile"   # repo-relative
context = "."                       # build context

# OpenCode runtime config dir. Defaults to ".kortix/opencode" when
# omitted. The agent daemon launches opencode with
# OPENCODE_CONFIG_DIR pointed here.
[opencode]
config_dir = ".kortix/opencode"

# ─── Triggers ─────────────────────────────────────────────────────
# Each `[[triggers]]` entry spawns a fresh session that runs `prompt`
# as its initial message. Slugs must be lowercase URL-safe and
# unique among triggers.

[[triggers]]
slug = "daily-digest"
name = "Daily digest"
type = "cron"
agent = "kortix"
enabled = true
cron = "0 0 9 * * 1-5"            # 09:00 Mon–Fri
timezone = "America/Los_Angeles"
prompt = """
Summarize yesterday's commits across the repo. Save the result to
notes/digest-{{ fired_at }}.md and open a PR against main.
"""

[[triggers]]
slug = "slack-hook"
name = "Slack handler"
type = "webhook"
agent = "kortix"
enabled = true
secret_env = "WEBHOOK_SLACK_SECRET"   # add value via Secrets Manager
prompt = """
Slack event from {{ headers.user_agent }}.
User said: {{ body.text }}
"""

# ─── Apps (experimental) ──────────────────────────────────────────
# Gated by the platform flag KORTIX_APPS_EXPERIMENTAL. When off,
# entries are parsed but never acted on.

[[apps]]
slug = "marketing-site"
name = "Marketing site"
enabled = true
framework = "next"
domains = ["marketing.example.com"]    # required, must be non-empty

  [apps.source]
  type = "git"
  repo = "https://github.com/me/site"  # optional — falls back to project repo
  branch = "main"
  root_path = "apps/site"

  [apps.build]
  command = "pnpm build"
  out_dir = "dist"

  [apps.env]
  NEXT_PUBLIC_API_URL = "https://api.example.com"
```

## Schema versioning

`kortix_version` is the schema version. Manifests without it are
treated as v1 for backward compat (`null`, `1`, and `"1"` all decode
to v1). A manifest declaring a version higher than the platform knows
about is rejected outright — the platform won't silently misread
future fields.

When the platform writes the manifest back (after a dashboard edit),
it ensures `kortix_version` is the first key, so the file is
self-describing at a glance.

## What's parsed where

| Surface                | What it reads                                                       |
| ---------------------- | ------------------------------------------------------------------- |
| Trigger sweep          | `[[triggers]]`                                                      |
| Sandbox builder        | `[sandbox]`                                                         |
| Sandbox runtime        | `[opencode]` (where to launch opencode with its config)             |
| Session bootstrap      | `[env]` (advisory — surfaced to dashboard, not enforced)            |
| Apps deploy sweep      | `[[apps]]` (when `KORTIX_APPS_EXPERIMENTAL=true`)                   |
| Dashboard UI           | All of the above + `[project]` + the raw manifest                   |

Unknown top-level tables are ignored — safe to add your own metadata,
but the platform won't react to it.

## `[project]`

Project metadata for the dashboard.

| Key           | Required | Notes                                |
| ------------- | -------- | ------------------------------------ |
| `name`        | yes      | Display name. Shown in the UI.       |
| `description` | no       | One-liner shown beside the name.     |

## `[env]`

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
that prefix, but you can list `KORTIX_FOO` in `[env]` without an
error from the parser. Don't — it'll just never have a value.

## `[sandbox]`

Sandbox base image **and hardware spec**. **Entirely optional.** Omitting
the table (or any key) falls back to defaults.

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

## `[opencode]`

Where the OpenCode runtime config lives. **Optional**, with a default.

| Key          | Default              | Notes                                                                            |
| ------------ | -------------------- | -------------------------------------------------------------------------------- |
| `config_dir` | `.kortix/opencode`   | Repo-relative dir. Same silent-fallback behavior as `[sandbox]` paths.            |

The agent daemon launches `opencode serve` with
`OPENCODE_CONFIG_DIR=<config_dir>`, so everything under that folder
becomes the OpenCode runtime: agents, skills, commands, tools, plugins,
`opencode.jsonc`.

## `[[triggers]]`

Array of tables. Each entry is a trigger that spawns a fresh session
on fire. Triggers are sorted alphabetically by slug in the parsed
output — UI ordering is stable, not authoring-order.

### Common fields

| Field        | Required | Type    | Default     | Notes                                                          |
| ------------ | -------- | ------- | ----------- | -------------------------------------------------------------- |
| `slug`       | yes      | string  | —           | `[a-z0-9][a-z0-9_-]{0,127}`, unique among triggers.            |
| `type`       | yes      | string  | —           | `"cron"` or `"webhook"`.                                       |
| `prompt`     | yes      | string  | —           | Mustache-style template. Alias: `prompt_template`.             |
| `name`       | no       | string  | `slug`      | Human label.                                                   |
| `agent`      | no       | string  | `"default"` | OpenCode agent name. Alias: `agent_name`.                      |
| `enabled`    | no       | bool    | `true`      | Accepts strings: `"true"/"false"/"yes"/"no"/"on"/"off"/"1"/"0"`. |

**Alias note:** the parser accepts both forms (`prompt` /
`prompt_template`, `agent` / `agent_name`, `cron` / `schedule`,
`secret_env` / `secretEnv`). The platform serializes back with the
canonical names, so editing-then-saving from the UI will normalize
aliases away.

**Slug uniqueness is per-section.** A trigger and an app may share
a slug; two triggers may not.

### Cron-only fields

| Field      | Required | Type    | Default | Notes                                                       |
| ---------- | -------- | ------- | ------- | ----------------------------------------------------------- |
| `cron`     | yes      | string  | —       | 6-field croner expression: `second minute hour day month weekday`. Alias: `schedule`. |
| `timezone` | no       | string  | `"UTC"` | IANA name, e.g. `"America/Los_Angeles"`.                    |

The platform polls every 60 s by default
(`KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS`), so sub-minute precision is
best-effort.

### Webhook-only fields

| Field        | Required | Type    | Notes                                                                                  |
| ------------ | -------- | ------- | -------------------------------------------------------------------------------------- |
| `secret_env` | yes      | string  | Name of a `project_secrets` entry holding the HMAC secret. Alias: `secretEnv`. Manifest-side regex is `^[A-Z_][A-Z0-9_]*$` (unbounded). |

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
| ----------------------- | --------------------------------------- |
| `{{ cron.schedule }}`   | The croner expression that just fired.  |
| `{{ cron.timezone }}`   | Configured tz (defaults to `"UTC"`).    |
| `{{ cron.fired_at }}`   | Same as top-level `fired_at`.           |
| `{{ cron.last_fired_at }}` | Previous fire timestamp (or empty).  |
| `{{ last_fired_at }}`   | Same as `cron.last_fired_at`.           |

Webhook-only additions:

| Variable          | Source                                                          |
| ----------------- | --------------------------------------------------------------- |
| `{{ body.* }}`    | JSON-parsed request body. Dotted access works.                  |
| `{{ headers.* }}` | `content_type`, `user_agent`, `forwarded_for`.                  |

### Runtime state

Manifest is the source of truth for **config**. The
`project_trigger_runtime` table is the source of truth for **state**
(`last_fired_at`, `event_count`). Writing to the repo on every fire
would amplify the scheduler tick into a flood of git commits.
If you need to know when a trigger last fired, check the dashboard,
not the repo.

### Common gotchas

- `[triggers]` (single brackets) is wrong — must be `[[triggers]]`
  (array of tables). The parser surfaces a clear error.
- Slugs must be lowercase + URL-safe. Uppercase or spaces fail.
- A webhook trigger without `secret_env` is rejected.
- A cron trigger without a `cron` expression is rejected.
- Bad entries surface in `errors` next to the good ones — they don't
  break the whole file.

## `[[apps]]` (experimental)

Gated behind `KORTIX_APPS_EXPERIMENTAL=true`. When the flag is off,
the `/apps` routes return 404 (with a JSON error explaining the
flag) and the deploy sweep skips every project.

`[[apps]]` declares deployable surfaces alongside the agent — think
fly.toml-style entries inside `kortix.toml`. The platform dispatches
through a provider adapter (Freestyle today; pluggable) and records
each deploy in the `deployments` table.

Entries sort alphabetically by slug. Slug uniqueness is per-section
(apps don't conflict with triggers of the same slug).

| Field      | Required | Type       | Notes                                                  |
| ---------- | -------- | ---------- | ------------------------------------------------------ |
| `slug`     | yes      | string     | URL-safe, unique among apps.                           |
| `name`     | no       | string     | Display name. Defaults to slug.                        |
| `enabled`  | no       | bool       | Defaults to `true`. Disabled apps are skipped.         |
| `domains`  | **yes**  | `string[]` | Must be non-empty. The parser rejects entries that omit or empty this. |
| `framework`| no       | string     | Hint for the provider adapter (e.g. `"next"`).         |

### `[apps.source]`

| Field       | Required for `git` | Required for `tar` | Notes                                                                 |
| ----------- | ------------------ | ------------------ | --------------------------------------------------------------------- |
| `type`      | yes                | yes                | `"git"` or `"tar"`.                                                   |
| `repo`      | no                 | —                  | Git clone URL. Falls back to the **project's own repo URL** if omitted. |
| `branch`    | no                 | —                  | Defaults to the project's default branch.                              |
| `root_path` | no                 | —                  | Path inside the source to deploy from. Defaults to `"."`.              |
| `url`       | —                  | yes                | HTTPS URL of the tarball.                                              |

### `[apps.build]`

| Field     | Required | Notes                                                                |
| --------- | -------- | -------------------------------------------------------------------- |
| `command` | no       | Build command. Empty → no build step.                                |
| `out_dir` | no       | Output directory served by the provider.                             |

If both are empty, the parsed entry collapses to `null` — the
provider treats it as "no build phase."

### `[apps.env]`

Key/value map. Keys must match `^[A-Za-z_][A-Za-z0-9_]*$` (mixed
case allowed, unlike `[env]` secrets which are uppercase-only).
Values must be strings — numbers and booleans are rejected.

### Hash-based redeploy

Apps redeploy when the manifest-derived hash of their config changes.
The hash **excludes** `slug` and `name` — renaming an app doesn't
trigger a redeploy. Edits to `source`, `build`, `env`, `domains`,
`framework`, or `enabled` do.

## Secrets

Per-project, encrypted at rest. The platform uses **AES-256-GCM** with
**HKDF-derived per-project keys** rooted in the platform's
`API_KEY_SECRET`. Stored in the `project_secrets` table; **never
inline in the repo**.

### Flow

1. Declare the secret name under `[env]`:
   ```toml
   [env]
   required = ["DATABASE_URL"]
   optional = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "WEBHOOK_SLACK_SECRET"]
   ```
2. Set the value in the Kortix Secrets Manager (dashboard).
3. When a session boots, the platform decrypts every secret on the
   project and injects them as plain env vars into the sandbox.
4. Your agent code reads them like any other env var.

### Rules

- Names in the Secrets Manager match `^[A-Z_][A-Z0-9_]{0,63}$`.
- `KORTIX_*` is reserved **at the Secrets Manager surface** — the
  CRUD endpoint rejects it. The manifest parser does not enforce
  this; declaring `KORTIX_FOO` in `[env]` is accepted but no matching
  secret can be created.
- Webhook triggers reference signing secrets by env-var name only
  (`secret_env = "WEBHOOK_FOO_SECRET"`). The value is resolved at
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
declare it in `[env].optional` so it shows up in the Secrets Manager,
and leave the trigger `enabled = false` until the user sets the value.

# kortix.yaml, kortix_version 3: key reference

The example is in `SKILL.md` → `<manifest>`. This page lists the keys and
rules. The schema is the authority: `kortix schema --version 3` prints it
(https://kortix.com/schema/kortix.v3.schema.json). `kortix validate` also
checks the cross-key rules. Unknown keys are errors.

## Top-level keys

| Key | Holds |
| --- | --- |
| `kortix_version` | `3`. Required. |
| `default_agent` | The agent a session or trigger runs when it names none. Required. A declared, enabled agent that is not `mode: subagent`. |
| `project` | `name`, `description`: shown in the dashboard. |
| `imports` | Repository paths of more YAML files or folders (below). |
| `env` | `required` and `optional` secret names. Values live in Kortix, never here. |
| `sandbox` | `default` template slug and `templates` (below). |
| `skills` | Registry: name → folder that holds `<name>/SKILL.md`. |
| `tools` | Registry: name → `.ts`/`.js` module (`tools.md`). |
| `commands` | Registry: name → `{ description, prompt \| prompt_file }`. |
| `extensions` | Registry: name → `{ pi: <npm pin or repo path> }` (`../pi.md`). |
| `connectors` | List of connectors (the `kortix-connectors` skill). |
| `apps` | Map of Apps and their settings (the `kortix-apps` skill). |
| `triggers` | List of triggers (below). |
| `policy`, `policies`, `approvals` | Connector call policies and how long a held call waits (`approvals.ttl`: `30m`, `4h`, `7d`; default 24h). |
| `agents` | Map of agent name → agent block. At least one. |

## Agent block

| Key | Value |
| --- | --- |
| `description` | What the agent does. The caller of `task` reads it. |
| `mode` | `primary`, `subagent` or `all`. A subagent target needs `subagent` or `all`. |
| `prompt` / `prompt_file` | The system prompt inline, or a repository `.md` path. Not both. |
| `model`, `variant` | Model id and reasoning tier. Omitted: the project default. |
| `temperature`, `top_p`, `steps` | Sampling, and the most model steps in one turn. |
| `color`, `hidden`, `options` | Display color, hide from pickers, provider options. |
| `permission` | Tool rules (`../pi.md` → Permissions). Omitted: `allow`. No `skill` or `task` key. |
| `enabled` | `false`: no session can start with this agent. Default `true`. |
| `codemode` | `on` (default), `only`, `off`. |
| `tools` | `all` (default), `none`, a list, or `{ exclude: [names] }`. |
| `skills`, `subagents`, `commands`, `extensions` | `all`, `none` (default) or registered names. Kortix skills count as registered. |
| `connectors`, `secrets`, `apps` | `all`, `none` (default) or names. |
| `policy_sets` | Connector slug → policy set name for this agent. |
| `kortix_permissions` | `all`, `none` (default) or a list of `project.*` values. |
| `workspace` | `{ project_repository: true }` checks out the repository in `/workspace`. Default `false`. |
| `sandbox` | A template slug, or `default`. |

## Registries

- A name is lowercase words joined by `-`, 64 characters at most (tools:
  snake_case). A `kortix-` skill name is reserved.
- A skill folder must end in the skill's name: `skills: { triage: skills/triage }`.
- A command sets exactly one of `prompt` or `prompt_file`. `$ARGUMENTS` and
  `$1`, `$2`, … take the arguments. A command runs on the agent that
  enables it.
- An extension sets `pi`: `"npm:<package>@<x.y.z>"`, a repository path, or
  `{ source, extensions, skills, prompts, themes }` to load part of a package.
- A skill, command or extension reaches only the agents that grant it. A
  tool reaches every agent whose `tools` allows it (default `all`).

## kortix_permissions

What an agent may do to the project through the CLI, the API and Git.

- `kortix validate --scopes` prints every grantable value. `all` or `"*"`
  is every value. Account actions (`member.*`, `billing.*`) are never
  grantable.
- Your effective grant is your `kortix_permissions` within your ceiling role.
  `project.read` in your own project is always granted.
  `project.credentials.issue` is for people only.
- Old names (`project.cr.*`, `project.customize.*`) still validate and are
  rewritten to the current values. Write the current values.
- You grant only what you hold, in the agent editor, a scope route or a
  merged CR.

| `403` code | Meaning | Do |
| --- | --- | --- |
| `agent_scope_insufficient` | The action is not in your `kortix_permissions`. | Propose a CR that adds it. |
| `agent_ceiling_insufficient` | Your ceiling role does not allow it. | Ask an admin. |
| `agent_human_only_action` | Only a person may do it. | Ask the user. |
| `agent_not_accessible` | The person may not run that agent. | Ask the user. |
| `agent_grant_escalation` | You tried to grant more than you hold. | Ask the user to grant it. |

`kortix whoami --token-only` prints your grant. It says `none` right after a
`kortix.yaml` change? The change broke your grant: revert it first.

## imports

```yaml
imports:
  - triggers/          # every .yaml/.yml below it, any depth, sorted by path
  - agents.yaml        # one file
```

- Paths are relative to the repository root: no `..`, no absolute path, no
  glob. At most 8 levels and 200 files.
- An imported file declares only `triggers`, `connectors`, `agents`, `apps`,
  `tools`, `skills`, `commands`, `extensions` and `imports`.
- One name lives in one file. A duplicate fails the whole manifest.
- A dashboard, CLI or API edit lands in the file that declares the entry;
  a new entry lands in `kortix.yaml`.

## env

`required` and `optional` are lists of secret names (`^[A-Z_][A-Z0-9_]*$`,
at most 64 characters, no `KORTIX_` prefix). `required` is advisory: a
session starts without the value. Set a value with `kortix secrets set` or a
link (`credentials-and-setup-links.md`).

## sandbox

```yaml
sandbox:
  default: python          # every agent; agents.<name>.sandbox overrides
  templates:
    - slug: python
      name: Python 3.12
      image: python:3.12-slim
      cpu: 2               # cores
      memory: 4            # GiB
    - slug: ml
      name: ML development
      dockerfile: Dockerfile.ml
      disk: 50             # GiB
```

- Each template sets exactly one of `image` or `dockerfile`. `default` is a
  reserved slug: the platform image.
- `kortix validate` lints each Dockerfile: no `COPY` from the repository, no
  `RUN` heredoc, a Debian-family base.
- A session uses the first that is set: an explicit template, the agent's
  `sandbox`, `sandbox.default`, the platform `default`.
- Put tools every session needs here. A package installed in a session can
  be gone when the session reopens.

## triggers

```yaml
triggers:
  - slug: digest
    on: { cron: "0 0 9 * * 1-5", timezone: Europe/Berlin }
    run: { agent: writer, prompt: "Write the digest." }
  - slug: deploy-hook
    on: { webhook: { secret: DEPLOY_HOOK_SECRET } }
    run: { prompt: "Check the deploy {{ body.id }}." }
  - slug: nightly-sync
    on: { every: 24h }
    run: { app: crm-sync, path: /sync }
  - slug: handle-reply
    on: { event: reply.received, app: inbox-poller }
    run: { prompt: "Answer {{ event.data.subject }}." }
```

| `on:` | Fires |
| --- | --- |
| `cron` (+ `timezone`, default UTC) | At each slot of a 6-field croner expression, at most once a minute. |
| `every` | Each fixed period: `5m`, `2h`; at least `60s`. |
| `at` | Once, at an ISO-8601 instant. |
| `webhook: { secret: <NAME> }` | On a signed `POST /v1/webhooks/projects/<project_id>/<slug>`. |
| `event: <name> \| "*"`, `app: <slug>` | When that App posts the event (`../scheduling.md` → App events). |

| `run:` | Does |
| --- | --- |
| `prompt` (+ `agent`, `model`, `session`, `session_key`, `session_id`) | Prompts an agent session. `agent` defaults to `default_agent`. |
| `app` (+ `path` default `/`, `method` `POST` or `GET`, `payload`) | Calls the App. No session, no model. |

- Other fields: `slug` (required, `[a-z0-9][a-z0-9_-]{0,127}`, unique across
  all files), `name`, `enabled` (default `true`), `filter` (dotted path →
  value that must match).
- `session`: `fresh` (default, a new session each fire), `reuse` (one
  long-lived session), `keyed` (with `session_key`), `pinned` (with
  `session_id`).
- `run:` takes `prompt` or `app`, never both.
- Webhook auth: `X-Kortix-Signature: sha256=<hex>` or GitHub's
  `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the secret), or the
  secret as `X-Kortix-Token` or `Authorization: Bearer`. Add
  `X-Kortix-Timestamp` (epoch seconds, within 5 minutes) and sign
  `<timestamp>.<body>` to stop replay. Answers: `202` queued, `200` skipped
  (paused or capped), `401` for every miss before authentication (no such
  enabled webhook trigger, bad signature), `402` no usable model.
- `kortix triggers pause` stops every trigger of the project; `resume`
  starts them again. `enabled: false` stops one.

Prompt variables, `{{ dotted.path }}` (a missing value renders empty):

| Fire | Variables |
| --- | --- |
| Every fire | `trigger.slug`, `trigger.type` |
| Schedule | `cron.schedule`, `cron.timezone`, `cron.scheduled_for`, `cron.last_scheduled_for` (empty on the first fire). No `fired_at`. |
| Webhook | `fired_at`, `body.*`, `headers.content_type`, `headers.user_agent`, `headers.forwarded_for` |
| App event | `event.name`, `event.data.*`, `event.id`, `event.emitted_at`, `app.slug` |

## Edits from the dashboard and the CLI

`kortix.yaml` owns what it declares. The web app, the API and the CLI
(`--apply`) commit their edits to it on the default branch. A push that
edits the file applies on the next sync. To change a declared setting,
change the file or use a command that commits to it. Keep an entry's shape
when you edit it: an `on:`/`run:` entry stays `on:`/`run:`.

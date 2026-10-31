# kortix.yaml: key reference

The example is in `SKILL.md` → `<manifest>`. This page lists the keys and
rules. The schema is the authority: `kortix schema` prints it
(https://kortix.com/schema/kortix.schema.json). `kortix validate` also
checks the cross-key rules. Unknown keys are errors.

The format has no version. It changes only by adding optional keys whose
defaults keep today's behavior, so a valid file stays valid.

## Top-level keys

| Key | Holds |
| --- | --- |
| `default_agent` | The agent that runs when nothing names one and My Kortix is off, and the agent My Kortix starts when it names none. A declared, enabled agent that is not `mode: subagent`. |
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
| `policy`, `policies`, `approvals` | Connector call policies and how long a held call stays decidable (`approvals.ttl`: `30m`, `4h`, `7d`; default 24h). Approve runs the held call once, as its caller, and resumes the agent with the result: the agent does not repeat it. A caller without a project-scoped token repeats it within 15 minutes. |
| `builtin_agents` | `my_kortix: false` removes My Kortix, the built-in agent (slug `mykortix`). Absent = on. |
| `spaces` | Work in progress: channels per area of work (below). |
| `agents` | Map of agent name → agent block. Omitted: My Kortix only. |

## Agent block

| Key | Value |
| --- | --- |
| `description` | What the agent does. The caller of `agent` reads it. |
| `mode` | `primary`, `subagent` or `all`. A subagent target needs `subagent` or `all`. |
| `prompt` / `prompt_file` | The system prompt inline, or a repository `.md` path. Not both. |
| `model`, `variant` | Model id and reasoning tier. Omitted: the project default. |
| `temperature`, `top_p`, `steps` | Sampling, and the most model steps in one turn. |
| `hidden` | `true` hides the agent from pickers. (`color` and `options` validate; pi ignores them.) |
| `permission` | Tool rules (`../pi.md` → Permissions). Omitted: `allow`. No `skill` or `task` key. |
| `enabled` | `false`: no session can start with this agent. Default `true`. |
| `codemode` | `on` (default), `only`, `off`. |
| `tools` | `all`, `none`, a list, or `{ exclude: [names] }`. Set it on every agent: omitted is every tool, with a warning. |
| `skills`, `extensions` | `all`, `none` (default), registered names, or `{ exclude: [names] }`: every one but those. Kortix skills count as registered. |
| `subagents`, `commands` | `all`, `none` (default) or registered names. `subagents` is who this agent may call with the `agent` tool. |
| `connectors`, `secrets`, `apps` | `all`, `none` (default) or names. |
| `policy_sets` | Connector slug → policy set name for this agent. |
| `kortix_permissions` | `all`, `none` (default) or a list of `project.*` values. |
| `workspace` | `{ project_repository: true }` checks out the repository in `/workspace`. Default `false`. |
| `sandbox` | A template slug, or `default`. |
| `space` | Work in progress: the space the agent works in. Grouping only, never a grant. |
| `network_egress` | Only `{ version: 1, default: deny, rules: [] }`. Declared, not enforced. |

## spaces (work in progress)

A space is a channel for one area of work: a room, then configured tabs
(`goals`, `apps`, `artifacts`, `files`, `app`, `artifact`, `link`, `board`).
It grants nothing. Spaces show only while the project flag
`project_channels` is on; it is off by default, and while it is off the
keys are kept but have no effect. A space's room needs `agent_rooms` (off
by default); a Goals tab needs `goals` (off by default). Do not build a space
unless the user asks and `kortix projects features` lists
`project_channels` on.

```yaml
spaces:
  sales: { label: Sales, order: 1, tabs: [{ type: apps }, { type: files, path: sales }] }
agents:
  closer: { space: sales, prompt: You run the sales pipeline., tools: all }
```

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
  tool reaches every agent whose `tools` allows it.

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
  - slug: verify-prod          # flat form: a merged change request has no on: shape
    type: change_request
    filter: { base: main }     # optional: merges into main only
    agent: writer
    prompt: "CR #{{ change_request.number }} merged. Verify prod."
```

| `on:` | Fires |
| --- | --- |
| `cron` (+ `timezone`, default UTC) | At each slot of a 6-field croner expression, at most once a minute. |
| `every` | Each fixed period: `5m`, `2h`; at least `60s`. |
| `at` | Once, at an ISO-8601 instant. |
| `webhook: { secret: <NAME> }` | On a signed `POST /v1/webhooks/projects/<project_id>/<slug>`. |
| `event: <name> \| "*"`, `app: <slug>` | When that App posts the event (`../scheduling.md` → Watch 24/7). |
| `event: <TYPE>`, `connector: <slug>` | When the connected app reports that event (flag `event_triggers`; types: `kortix triggers events --connector <slug>`). |

| `run:` | Does |
| --- | --- |
| `prompt` (+ `agent`, `model`, `session`, `session_key`, `session_id`) | Prompts an agent session. Without `agent` it runs My Kortix (`default_agent` when My Kortix is off). |
| `app` (+ `path` default `/`, `method` `POST` or `GET`, `payload`) | Calls the App. No session, no model. |

- Other fields: `slug` (required, `[a-z0-9][a-z0-9_-]{0,127}`, unique across
  all files), `name`, `enabled` (default `true`), `filter` (dotted path →
  value that must match).
- `session`: `fresh` (default, a new session each fire), `reuse` (one
  long-lived session), `keyed` (with `session_key`), `pinned` (with
  `session_id`).
- `run:` takes `prompt` or `app`, never both.
- `type: change_request` fires once per merged change request of the
  project. `filter.base` is the branch it must merge into (any when absent);
  other `filter` keys match the payload as on any trigger.
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
| Change request merged | `fired_at`, `change_request.cr_id`, `.number`, `.title`, `.base_ref`, `.head_ref`, `.merge_commit_sha` |

## Problems

`kortix validate` exits `1` on an error, unknown keys included. `kortix
ship`, the CR merge and every Kortix write refuse such a file. A file
already on the default branch never stops the project. What runs with an
error:

| The error is in | At run time |
| --- | --- |
| An unknown key, anywhere | Ignored. |
| An agent or a trigger | That entry is off. A session that names the agent fails with the issue. |
| A connector, App, skill, tool, command, extension, space or sandbox template | That entry is gone. |
| `project` or `default_agent` | The key falls back to its default. |
| Anything else (`env`, `sandbox`, `policy`, `policies`, `approvals`, `imports`, an unknown format version, YAML syntax) | Only My Kortix runs, so it can fix the file. |

Each rule only takes access away. The project page shows the errors and
the warnings without a fix id, with **Fix with My Kortix**. Every session's
system prompt lists the errors.

A deprecated key is not an error: it still works, and `kortix validate`
warns with its replacement and a fix id. Run `kortix validate --fix` to
rewrite every deprecated key (and the files `imports:` names) to the latest
shape, comments kept. Never write a deprecated key in new config.

An older format still works: Kortix reads it converted, each agent `.md`
frontmatter as the agent's keys and its body as the prompt. `kortix
validate` warns once (`fix: legacy-format`), lists what has no place in
this format, and validates the converted file. `kortix validate --fix`
converts the files: it writes kortix.yaml, keeps only the prompt in each
agent `.md`, and deletes the old files it replaces. Commit all of it in one
CR. The other CLI commands that edit the file refuse until it is converted.

## Edits from the dashboard and the CLI

`kortix.yaml` owns what it declares. The web app, the API and the CLI
(`--apply`) commit their edits to it on the default branch. A push that
edits the file applies on the next sync. To change a declared setting,
change the file or use a command that commits to it. Keep an entry's shape
when you edit it: an `on:`/`run:` entry stays `on:`/`run:`.

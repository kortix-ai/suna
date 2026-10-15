# `kortix.yaml` — in-depth reference

`kortix.yaml` is the single source of truth for everything the Kortix
platform reads about a project. It lives at the repo root. This page
documents `kortix_version: 3`, the current version.

A v3 manifest does two things:

1. **It registers what exists.** `skills`, `tools`, `commands`,
   `extensions`, `connectors`, `apps`, `env` (secret names) and `sandbox`
   templates. A registry entry gives a thing a name. It gives no agent
   access to it.
2. **It defines every agent.** Each `agents.<name>` block holds the
   agent's prompt, model and tool policy, and the registered things it
   enables by name.

Nothing applies to every agent: no project-wide permission, command or
extension. Harness-specific code lives only under `extensions`, with one
implementation per harness. Unknown keys are errors. A v3 session reads
only the compiled manifest, never `harnesses/`, `.kortix/`, `.opencode/`,
`.pi/`, `opencode.jsonc` or a pi `settings.json`.

The authoritative structural spec is the public JSON Schema:
`https://kortix.com/schema/kortix.v3.schema.json`, or
`https://kortix.com/schema/kortix.schema.json` for all published versions.
Use `kortix schema --version 3` offline. Versions 1 and 2 are legacy: see
[Legacy versions](#legacy-versions).

## Version 3 example

```yaml
# yaml-language-server: $schema=https://kortix.com/schema/kortix.v3.schema.json
kortix_version: 3

project:
  name: acme-support
  description: Answers help desk tickets and reports on them.

default_agent: assistant

# The harness a session boots: "opencode" (the default) or "pi".
runtime: opencode

# Secret names the runtime needs. `required` is *advisory* — surfaced in
# the dashboard so the user knows what to set, not enforced at session start.
env:
  required: [HELPDESK_TOKEN]
  optional: [SLACK_WEBHOOK_URL, WEBHOOK_SLACK_SECRET]

# Named sandbox environments. Each template uses one image or Dockerfile.
sandbox:
  default: support
  templates:
    - slug: support
      name: Support
      dockerfile: sandbox/Dockerfile
      cpu: 2
      memory: 4

# Connector-call approvals (the connector registry's rules).
policy:
  default_mode: risk
policies:
  - match: helpdesk.close_ticket
    action: require_approval

# ─── Registries: what exists in this project ─────────────────────
skills:
  pdf: skills/pdf                                # skills/pdf/SKILL.md
  triage-rules: support/skills/triage-rules

tools:
  lookup_order: tools/lookup_order.ts            # the seven Kortix tools need no entry

commands:
  summarize:
    description: Summarize a text in five bullets.
    prompt: Summarize $ARGUMENTS in five bullets.
  weekly-report:
    description: Write the weekly support report.
    prompt_file: support/commands/weekly-report.md

extensions:
  audit:
    opencode: extensions/audit.opencode.ts       # an OpenCode plugin module
    pi: extensions/audit.pi.ts                   # a pi extension file
  web-access:
    pi: npm:pi-web-access@0.30.0                 # a pi package, exact version

connectors:
  - slug: helpdesk
    name: Help desk
    provider: openapi
    spec: https://helpdesk.example.com/openapi.json
    auth:
      type: bearer

# ─── Apps ─────────────────────────────────────────────────────────
# Local, repeatable deployment defaults. `kortix apps deploy` remains the
# explicit deployment action; merging this file does not auto-deploy.
# Each block is the App's release config: a deploy creates an immutable release of
# its artifact and this config (processes, http_service, services, mounts, vm,
# deploy). `kortix apps launch --template convex` writes the `backend` block
# below (a self-hosted Convex backend: data, functions, realtime, files) plus
# `backend-dashboard` (admins only, the Dashboard tab of `backend`, signed in by
# the BACKEND_ADMIN_KEY secret).
# `kortix apps deploy` with no arguments deploys every block, used Apps first.
# Code lives in one folder per App, apps/<name>/ by default (`path` is free-form:
# group by team or topic when that fits better). The backend's functions live in
# apps/backend/convex (`npx convex deploy`); its image needs no `path`.
# A static App (files, no machine) ignores run mode, resources, env
# and secrets. A server App runs always on (default, billed 24/7) or on demand
# (billed while awake). Apps have no budget:
# `monthly_budget_usd` is retired and `kind` is retired (the validator warns).
apps:
  backend:
    type: oci_image
    image: ghcr.io/get-convex/convex-backend@sha256:<digest>   # pinned by the template
    command: ["sh", "-c", "cd /convex && CONVEX_CLOUD_ORIGIN=$KORTIX_APP_URL CONVEX_SITE_ORIGIN=$KORTIX_SERVICE_URL_SITE exec ./run_backend.sh"]
    labels: [backend]          # tags only; no behavior depends on them
    display: { preview: none } # an icon card; listed | preview (live | none) | parent
    always_on: true
    vm: { cpu: 1, memory_gb: 1, disk_gb: 10 }
    mounts:                    # a volume: outlives every release and machine
      - { source: data, destination: /convex/data, initial_size_gb: 10 }
    http_service:              # the App's own host
      internal_port: 3210
      access: public           # public | app (the App's policy) | admins
      checks: [{ type: http, path: /version }]
    services:                  # more ports, each on <App host>--<name>
      - { name: site, internal_port: 3211, access: public }
  backend-dashboard:           # Convex's dashboard is a second image, so a second App
    path: apps/backend/dashboard # Dockerfile + start.js, written by `launch`
    type: dockerfile
    command: [node, /kortix/start.js]
    display: { parent: backend } # the Dashboard tab of backend, not a card of its own
    uses: [backend]
    always_on: false           # sleeps when idle
    http_service: { internal_port: 6791, access: admins }
    secrets:                   # env name → project secret identifier
      NEXT_PUBLIC_ADMIN_KEY: BACKEND_ADMIN_KEY # written by `launch`; the dashboard opens signed in
  storefront:
    path: apps/storefront/dist # build first (in apps/storefront); deploy the output directory
    type: static
    spa: true
    uses: [backend]            # may bind to backend and mint its sign-in tokens
  api:
    path: apps/api
    type: dockerfile
    command: ["node", "server.js"]
    port: 3000
    readiness_path: /health
    always_on: false           # on demand: stops when idle, wakes on request
    processes:                 # process groups; default: one group, `app`
      app: ""                  # "" runs the image's own command
      worker: "node worker.js" # no service: a worker, never idle-stopped
    deploy:
      strategy: bluegreen      # rolling | immediate | bluegreen | canary
      release_command: "node migrate.js"   # once per release; a failure aborts it
    idle_timeout_seconds: 300
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
    agent: assistant
    enabled: true
    cron: "0 0 9 * * 1-5"            # 09:00 Mon–Fri
    timezone: America/Los_Angeles
    prompt: |
      Summarize yesterday's commits across the repo. Save the result to
      notes/digest-{{ fired_at }}.md and open a CR against main.

  - slug: slack-hook
    name: Slack handler
    type: webhook
    agent: assistant
    enabled: true
    secret_env: WEBHOOK_SLACK_SECRET   # add value via Secrets Manager
    prompt: |
      Slack event from {{ headers.user_agent }}.
      User said: {{ body.text }}
  - slug: weekly-report
    type: cron
    agent: reporter
    cron: "0 0 15 * * 1"
    timezone: Europe/Berlin
    prompt: Write the weekly support report for the last 7 days.

# ─── Agents: each one decides what it uses ───────────────────────
agents:
  assistant:
    description: The project's main agent. Answers tickets and delegates research.
    mode: primary
    model: kortix/glm-5.3-flash
    prompt_file: agents/assistant.md
    permission:
      bash:
        "*": allow
        "git push *": ask
      external_directory: deny
    tools: all
    skills: all
    subagents: [researcher]
    commands: [summarize, weekly-report]
    extensions: [audit]
    connectors: [helpdesk]
    secrets: [HELPDESK_TOKEN]
    apps: [api]
    kortix_permissions: [project.session.read, project.review.submit]

  researcher:
    description: Looks up an account's order history. Never edits files.
    mode: subagent
    prompt: |
      You research one account. Read its orders with lookup_order and
      report what you found. Never edit files.
    permission:
      edit: deny
      bash: deny
    tools: [read, grep, lookup_order, web_search]
    skills: [triage-rules]
    secrets: [HELPDESK_TOKEN]

  reporter:
    description: Writes the weekly report on a schedule.
    mode: primary
    hidden: true
    prompt_file: support/agents/reporter.md
    commands: [weekly-report]
    extensions: [web-access]
    codemode: only
    connectors: [helpdesk]
    secrets: [SLACK_WEBHOOK_URL]
    workspace:
      project_repository: false
```

## `agents:`

`agents` maps an agent name (`[a-z0-9][a-z0-9_-]{0,127}`) to one block.
At least one agent is required. Only declared agents run: OpenCode's
`build`, `plan`, `general` and `explore` are off unless the manifest
declares that name, and pi offers no built-in `general` or `explore`
subagent. Both harnesses run the same compiled agent.

### Behavior keys

| Key | Default | Compiles to |
| --- | --- | --- |
| `description` | none | The agent's description. A parent agent reads it to pick a subagent. |
| `mode` | `all` | `primary` (a session runs it), `subagent` (another agent starts it), `all` (both). |
| `prompt` | none | The system prompt, as text. |
| `prompt_file` | none | The system prompt, read from a repository `.md` file. Set `prompt` or `prompt_file`, not both. A missing file fails the session compile. |
| `model`, `variant`, `temperature`, `top_p`, `steps` | harness default | The same keys. `steps` is a positive integer. |
| `options`, `color` | none | The same keys. pi ignores both. |
| `hidden` | `false` | `true` hides the agent from agent menus. |
| `enabled` | `true` | `false` compiles to `disable: true`. It cannot be `default_agent`. |
| `permission` | `allow` | The tool policy: an action (`allow`, `ask`, `deny`) or a map of tool to action or pattern map. |

`permission` rules:

- Omitted is `allow`. A tool never waits for a person unless the agent says `ask`.
- There is no top-level `permission`. Each agent has its own.
- `permission.skill` and `permission.task` are errors: use `skills` and `subagents`.
- `bash: deny` also denies the `pty_*` terminal tools, and `edit: deny` also denies `memory`, unless the agent sets a rule for those tools.

### What the agent enables

| Key | Default | Values | Compiles to |
| --- | --- | --- | --- |
| `tools` | `all` | `all`, `none`, a list, `{ exclude: [names] }` | The tools the model sees. Names are harness, Kortix or registered tools. |
| `skills` | none | grant set | `permission.skill`: each granted skill `allow`, then `"*": deny`. `all` = every registered and Kortix skill. |
| `subagents` | none | grant set | `permission.task`: each granted agent `allow`, then `"*": deny`. A name must be another declared agent with mode `subagent` or `all`. |
| `commands` | none | grant set | The command lists this agent among the agents that may run it. |
| `extensions` | none | grant set | The OpenCode plugins / pi packages a session of this agent loads. |
| `codemode` | `on` | `on`, `only`, `off` | pi's codemode tool. OpenCode ignores it. |

A grant set is `all` (or `"*"`, or a list that contains `"*"`), `none`
(or `""`, `[]`), or a list of names. Every listed name must be
registered (or a built-in); anything else is an error. **An agent with no
`skills` key loads no skill, not even a Kortix skill.**

### Kortix access

| Key | Default | Notes |
| --- | --- | --- |
| `connectors` | none | Connector slugs the agent may call. |
| `connectors_required` | none | Subset of `connectors` that needs a connected account. Parsed, not read at session start. |
| `secrets` | none | Secret names the agent receives in its sandbox. |
| `apps` | none | Restricted or private Apps it may open. The App gate also needs `project.app.read`. |
| `kortix_permissions` | none | Project actions through the CLI, the API, or git. Effective = this list ∩ the agent's ceiling role − `project.credentials.issue`. `kortix validate --scopes` prints the list. |
| `workspace.project_repository` | `true` | `false`: no checkout in `/workspace` and no repository access (`403`). |
| `sandbox` | `sandbox.default` | A sandbox template slug, or `default`. |
| `network_egress` | none | Declaration only: `{ version: 1, default: deny, rules: [] }`. Warns; not enforced. |

Agent keys from earlier versions are errors with a pointer to the
replacement: `file` (use `prompt` / `prompt_file`), `disable`
(`enabled: false`), `opencode` and `harnesses` (behavior keys,
`extensions`, `codemode`), `env` (`secrets`), `kortix_cli`
(`kortix_permissions`), `connectors_personal` (`connectors_required`),
`repository_access` (`workspace.project_repository`), and the map form
`tools: { bash: false }` (`tools: { exclude: [bash] }`).

**Resolution at session start:** only a declared, enabled agent can be
launched. `default_agent` must name a declared, enabled agent with mode
`primary` or `all`. A grant takes effect once its change request merges
(read from the default branch). The agent is the acting principal; the
launcher only needs "may run this agent". The dashboard agent editor,
`kortix agents scope|config|default` and `kortix secrets grant` edit v2
manifests only: on v3, edit the block and open a change request.

## The three permission layers

| Layer | Key | Where | Decides |
| --- | --- | --- | --- |
| Tool policy | `permission` | each agent | Whether a harness tool call runs, waits for a person, or is refused. |
| Kortix permissions | `kortix_permissions` | each agent | Which Kortix project actions the agent's own token may take. |
| Connector approvals | `policy`, `policies`, a connector's `policies` | the connector registry | Whether a connector call runs, needs approval, or is blocked. |

`policy.default_mode` is `allow_all` (default) or `risk` (a read runs; a
write or destructive call needs approval). A `policies` rule matches
`<connector-slug>.<tool>` with `*` globs; project rules are checked first,
then the connector's own `policies`; the first match wins. `kortix
validate` does not check `policy` or `policies`.

## Registries

**Names.** A skill, command or extension name matches
`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters. A tool name is snake
case, `^[a-z][a-z0-9_]{0,63}$`.

**Paths.** Repo-relative. No leading `/` or `-`, no `.`, `..` or empty
segment. Every path in an imported file is still relative to the
repository root, not to that file.

**Built-ins are always registered.** The seven Kortix tools (`web_search`,
`image_search`, `scrape_webpage`, `memory`, `show`,
`kortix-connectors_call`, `kortix-connectors_describe`) and the 12 Kortix
skills (`kortix-apps`, `kortix-computer`, `kortix-connectors`,
`kortix-drives`, `kortix-genui`, `kortix-harness-refinement`,
`kortix-marketplace`, `kortix-memory`, `kortix-onboarding`,
`kortix-slack`, `kortix-system`, `kortix-teams`) exist without an entry.
An agent still grants them by name.

### `skills:`

Name → the folder that holds `SKILL.md`. The folder's last segment is the
name (`pdf: skills/pdf`), and the `SKILL.md` frontmatter `name` is the same.
A name that starts with `kortix-` is an error. A session loads exactly the
registered folders and the Kortix skills; an unregistered `SKILL.md` is
never visible.

### `tools:`

Name → a module (`.ts`, `.js`, `.mts`, `.mjs`, `.cts`, `.cjs`). A harness
tool name or a `pty_` name is an error. A Kortix tool's name replaces that
tool for every agent. The v2 value `kortix:<name>` is an error.
`references/kortix/tools.md` has the module contract.

### `commands:`

Name → `{ description?, prompt | prompt_file }`. Exactly one of `prompt`
and `prompt_file`; no other key (a command has no `agent`: it runs on the
agent that enables it). `$ARGUMENTS` takes everything after the command
name; `$1`, `$2`, … take one word each, the last takes the rest. A command
no agent enables is not compiled. Running a command on an agent that does
not enable it answers `403` `command_not_enabled`.

### `extensions:`

Name → `{ opencode?, pi? }`, at least one:

- `opencode`: a repo module, loaded as an OpenCode plugin.
- `pi`: `npm:<name>@<x.y.z>` (an exact version), a repo path (file or
  folder), or `{ source, extensions?, skills?, prompts?, themes? }` (each
  filter a list of globs; omitted loads everything, `[]` loads nothing).

An extension without an implementation for the session's harness does
nothing there. A session loads the extensions of the agent it starts
with; a mid-session agent switch keeps them. The change request merge
builds npm pi packages; a session never runs `npm install`.

## `runtime:`

The harness a session boots. Root-only. `opencode` (default) or `pi`.
Kortix picks it when a session starts, restarts or resumes: the project's
`llm_gateway` flag off → OpenCode; the `pi_harness` flag on → pi;
`runtime: pi` → pi; anything else → OpenCode. pi calls models only
through the LLM gateway. `../pi/overview.md` lists what pi supports.

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

`kortix_version` is the schema version. Version 3 is YAML-only and
requires `default_agent` and `agents`. A version above `3` is rejected
outright — the platform never silently misreads future fields. A
`kortix.toml` that declares version `2` or `3` is an error.

When the platform writes the manifest back (after a dashboard edit), it
keeps `kortix_version` as the first key.

## What's parsed where

| Surface                | What it reads                                                       |
| ---------------------- | ------------------------------------------------------------------- |
| Trigger sweep          | `triggers:`                                                          |
| Sandbox builder        | `sandbox:`                                                           |
| Session compile        | `agents:`, `skills:`, `tools:`, `commands:`, `extensions:`, `runtime:`, and every `prompt_file` |
| Session bootstrap      | `env:` (advisory — surfaced to dashboard, not enforced)              |
| Apps CLI               | `apps:` (local deployment defaults; deploy remains explicit)          |
| Session token mint     | `agents:` (per-agent connectors/secrets/skills/apps/kortix_permissions scope) |
| Connector catalog      | `connectors:`, `policy:`, `policies:`                               |
| Agent/model UI         | Server-side agent registry + LLM-gateway model catalog                |
| Dashboard UI           | All of the above + `project:` + the raw manifest                     |

Every surface reads the MERGED manifest when the root declares
`imports:`. An unknown key is an error, at the top level and in an agent,
command or extension. Retired top-level keys name their replacement:
`permission` (per agent), `harnesses` (`extensions` + agent `codemode`),
`opencode` and `pi` (no harness folder in v3), `channels` (connect a
channel in the dashboard), `sandboxes` (`sandbox.templates`).

## `imports:` — split the manifest across files

Use it when `kortix.yaml` outgrows one screen: one file per agent, one
file per registry, and a feature folder that holds its own agents,
prompts, commands, skills and triggers.

```text
kortix.yaml                  root: kortix_version, project, default_agent, runtime, env, sandbox, policy, imports
agents/assistant.yaml        agents: { assistant: … }
agents/assistant.md          its prompt_file
agents/researcher.yaml
skills/skills.yaml           skills: { pdf: skills/pdf }
tools/tools.yaml             tools: { lookup_order: tools/lookup_order.ts }
commands/commands.yaml
extensions/extensions.yaml
connectors/helpdesk.yaml
apps/apps.yaml               one file: App sources can hold other YAML
triggers/nightly-triage.yaml
support/support.yaml         a feature folder: skills, commands, agents, triggers
support/agents/reporter.md
support/commands/weekly-report.md
support/skills/triage-rules/SKILL.md
```

```yaml
# kortix.yaml
kortix_version: 3
default_agent: assistant
imports:
  - agents/                    # a directory: every .yaml/.yml below it, any depth
  - skills/skills.yaml         # a single file
  - tools/tools.yaml
  - commands/commands.yaml
  - extensions/extensions.yaml
  - connectors/
  - apps/apps.yaml
  - triggers/
  - support/support.yaml
```

```yaml
# support/support.yaml
skills:
  triage-rules: support/skills/triage-rules
commands:
  weekly-report:
    description: Write the weekly support report.
    prompt_file: support/commands/weekly-report.md
agents:
  reporter:
    description: Writes the weekly report on a schedule.
    mode: primary
    hidden: true
    prompt_file: support/agents/reporter.md
    commands: [weekly-report]
triggers:
  - slug: weekly-report
    type: cron
    agent: reporter
    cron: "0 0 15 * * 1"
    prompt: Write the weekly support report for the last 7 days.
```

The platform merges the root and every import into one manifest before
it validates, compiles agents, sweeps triggers, or mints agent grants. A
grant in one file can name a skill, command or extension registered in
another.

Rules:

- Paths are relative to the repository root. No `..`, no absolute
  paths, no globs. A path that matches no `.yaml`/`.yml` file is an error.
- A directory import takes every `.yaml`/`.yml` below it, sorted by path.
- An imported file declares only `agents`, `skills`, `tools`,
  `commands`, `extensions`, `connectors`, `apps`, `triggers` and
  `imports` (nesting: max 8 levels, 200 files). Any other key in an
  imported file is an error. `kortix_version`, `project`,
  `default_agent`, `runtime`, `env`, `sandbox`, `policy` and `policies`
  stay in `kortix.yaml`.
- **Import a file, not a folder, when the folder holds other YAML.** An
  App's source (`pnpm-workspace.yaml`, a compose file) or a skill's
  reference files can hold YAML that is not manifest YAML; a directory
  import of that folder fails the whole manifest. Import `apps/apps.yaml`,
  not `apps/`.
- One name, one file. The same agent, skill, tool, command, extension or
  App name, or trigger/connector slug, in two files is an error naming
  both files. Nothing overrides silently.
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
      dockerfile: Dockerfile.gpu
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

## `triggers:`

A list. Each entry is a trigger that spawns a fresh session
on fire. Triggers are sorted alphabetically by slug in the parsed
output — UI ordering is stable, not authoring-order.

### Common fields

| Field        | Required | Type    | Default     | Notes                                                          |
| ------------ | -------- | ------- | ----------- | -------------------------------------------------------------- |
| `slug`       | yes      | string  | —           | `[a-z0-9][a-z0-9_-]{0,127}`, unique among triggers.            |
| `type`       | yes      | string  | —           | `"cron"`, `"webhook"`, `"monitor"`, or `"event"`.              |
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

### Event-only fields

An event trigger runs when something happens in a connected app. Kortix
subscribes to the event for you: no `secret_env`, no signature.

| Field       | Required | Type   | Notes                                                                                           |
| ----------- | -------- | ------ | ----------------------------------------------------------------------------------------------- |
| `connector` | yes      | string | Slug of a connector (profile) under `connectors:`.                                              |
| `account`   | no       | string | Label of one shared account of that connector. Omit it to use the connector's default shared account. Set it only when the connector has several shared accounts. Valid on `type: event` only. An unknown label gives status `needs_connection`, not an error. |
| `event`     | yes      | string | Provider event type, e.g. `GITHUB_PULL_REQUEST_CREATED`. List with `kortix triggers events --connector <slug>`. |
| `config`    | no       | map    | Settings of the event (e.g. `repo`). Fields and descriptions: `kortix triggers events --connector <slug> --event <TYPE>`. |
| `filter`    | no       | map    | Same guard a webhook uses, e.g. `"event.data.draft": "false"`. Every entry must match.          |

```yaml
triggers:
  - slug: pr-review
    type: event
    connector: github-work # the connector profile
    account: acme-bot # optional: a shared account of that profile
    event: GITHUB_PULL_REQUEST_CREATED
    config: { repo: acme/api }
    session_mode: fresh
    filter:
      "event.data.draft": "false"
    prompt: |
      Review {{ event.data.html_url }}
```

An event trigger takes none of `cron`, `run_at`, `timezone`, `secret_env`.

**Subscription status** (`kortix triggers ls` / `info`):

| Status | Word in the CLI | Meaning | Fix |
| --- | --- | --- | --- |
| `active` | `live` | The subscription exists. Events fire the trigger. | None. |
| `pending` | `pending` | Declared; the subscription is not created yet. | Wait, then `kortix triggers info <slug>`. If it stays, save the trigger again. |
| `needs_connection` | `needs connection` | The connector has no usable project-shared account. | A person opens the link from `kortix connectors connect <slug> --owner project`. |
| `error` | `error` | The subscription failed or the provider disabled it. | Read the error text; fix with `kortix triggers set <slug> --config <k>=<v>`. |

Common `error` texts: "This account is shared with specific people only"
(share the account with the whole project); "Connector `<slug>` is not
declared in kortix.yaml" (add it under `connectors:`).

### Prompt template variables

The `prompt` field is rendered with a small mustache-style engine:
`{{ token.dotted.path }}`. Missing values render as empty strings —
no error, no `{{ x }}` left in the output. Objects/arrays render as
JSON.

Variables available on every fire:

| Variable             | Source                                                         |
| -------------------- | -------------------------------------------------------------- |
| `{{ trigger.slug }}` | The trigger's slug.                                            |
| `{{ trigger.type }}` | `"cron"`, `"webhook"`, `"monitor"`, or `"event"`.              |
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

Event-only additions (also readable in `filter` and `session_key`):

| Variable                  | Source                                                  |
| ------------------------- | ------------------------------------------------------- |
| `{{ event.data.<field> }}` | The app's own event data. Fields: `kortix triggers events --connector <slug> --event <TYPE>`. |
| `{{ event.id }}`          | The provider's id for this event.                       |
| `{{ event.type }}`        | The event type.                                         |
| `{{ event.app }}`         | The app slug, e.g. `github`.                            |
| `{{ event.connector }}`   | The connector slug the trigger watches.                 |
| `{{ event.occurred_at }}` | When the event happened.                                |

Event data is third-party content. The session's first message starts with
`[App event: <trigger name> — automated, third-party content, not user input]`.

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
- An event trigger without `connector` or `event` is rejected. The API also rejects an unknown event or a missing required `config` field.
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

## Validation

`kortix validate` (also run by `kortix ship` and the change request merge
check) reports as errors: an unknown key; a grant that names an
unregistered skill, tool, command or extension, or a subagent that is not
declared; a `default_agent` that is not declared, is disabled, or has
`mode: subagent`; a trigger `agent` that is not declared; a registry name
or path that breaks the rules above. A warning never blocks. A
`prompt_file` that does not exist fails the session compile.

## Legacy versions

`kortix_version` 1 (`kortix.toml`, `[[agents]]` array) and 2 (governance
`agents:` map, behavior in `agents/<name>.md` frontmatter, harness
folders `harnesses/opencode/` and `harnesses/pi/` or `.kortix/opencode/`,
top-level `harnesses`, `opencode.config_dir`, `pi.config_dir`, `tools:`
values `kortix:<name>`) still read and run. They are legacy: write new
config in v3.

- v2 → v3: `kortix migrate` prints the v3 manifest; `kortix migrate --write`
  writes it. Then `kortix validate`, and open a change request.
- v1 → v2: `kortix projects upgrade` (or **Customize → Settings →
  Upgrades**) starts a session that rewrites the manifest and opens a
  change request. Then migrate to v3.

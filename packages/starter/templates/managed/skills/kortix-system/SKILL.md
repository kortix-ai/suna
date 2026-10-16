---
name: kortix-system
description: "Canonical reference for Kortix projects, Apps (sites, servers, backends with volumes) and internal business apps, the CLI, sessions, sandboxes, change requests, triggers, connectors, secrets, system skills, and the two session harnesses, pi and OpenCode. Covers `kortix.yaml` version 3 (the registry of skills, tools, commands and extensions, and each agent's block) and the legacy versions 1 and 2, App deployments, extensions per harness, session identity, credential boundaries, and the complete pi and OpenCode references. Load when the user asks how Kortix works, what Kortix can do, how to deploy an App, how an agent discovers platform instructions, how to customize or configure this project's agents (create or fix an agent, subagent, skill, tool, plugin, extension, pi package, command, MCP server, model or permission rule), how to edit `kortix.yaml`, how to use the `kortix` CLI, how to land work through a change request, or how to schedule and automate work."
---

<skill name="kortix-system">

<live-skills>
The `kortix` CLI is the live source of truth for how Kortix works. The Kortix
**system skills** — `kortix-system`, `kortix-apps`, `kortix-connectors`,
`kortix-memory`, `kortix-harness-refinement`, `kortix-slack`,
`kortix-computer`, `kortix-marketplace` — are served fresh by the CLI,
so their instructions always match the platform version you're running on (no
re-install, no image re-bake):

- `kortix system-skills` — list the Kortix system skills.
- `kortix system-skills get <name>` — print one skill's current SKILL.md body.
- `kortix system-skills get <name> --full` — also include its referenced files.

`kortix skills` is a permanent compatibility alias. Optional, non-system
skills are marketplace items. Browse them with
`kortix marketplace list --type skill`.

Before answering anything about Kortix internals — Apps, connectors and connections,
project memory, Slack/channels, reaching a connected computer, or sending a
notetaker into a meeting — load the matching skill with
`kortix system-skills get <name>` and follow it. Prefer this over any stale
local copy. The CLI reflects the deployed platform.

For App deployment or lifecycle work, load `kortix-apps`. It contains the
source-type decision tree, fast paths, blocking behavior, and verification
contract.
</live-skills>

<overview>
A **Kortix project** is one GitHub repo with a `kortix.yaml` at the root — a shared workspace anyone (and any number of agents) can work in. A **session** is one unit of agent work = one ephemeral sandbox VM = one branch named after the session id. The sandbox dies when the session ends; the branch persists. Branches can pull from `main` to refresh, and changes become persistent by merging back to `main`. Sessions are isolated, but the underlying repo is the global workspace.

**Check `kortix_version` at the top of `kortix.yaml` first, and edit in
that version.** New projects are created on `kortix_version: 2`. Version 3
is available as an opt-in. Never change a project's `kortix_version`
unless the user asks for it: `kortix migrate` converts a v2 project to v3
on request. The v2 reference is `references/kortix/kortix-yaml-v2.md`.

`kortix.yaml` defines the project. In `kortix_version: 3` it does two things:

- **It registers what exists.** `skills` (name → folder with `SKILL.md`),
  `tools` (name → module), `commands` (name → prompt), `extensions`
  (name → one implementation per harness), plus `connectors`, `apps`,
  `env` (secret names) and `sandbox` templates. A registry entry gives a
  thing a name. It gives no agent access to it.
- **It defines every agent.** Each `agents.<name>` block holds the agent's
  prompt (`prompt` or `prompt_file`), model, `permission`, and the
  registered things it enables by name: `tools`, `skills`, `subagents`,
  `commands`, `extensions`, `connectors`, `secrets`, `apps`,
  `kortix_permissions`.

Nothing applies to every agent: there is no project-wide permission,
command or extension. Harness-specific code lives only under `extensions`.
The repository holds the files the manifest names. The paths are
conventions, because `kortix.yaml` names each file:

- `agents/<name>.md` — an agent's prompt (`prompt_file`).
- `skills/<name>/SKILL.md` — a skill, registered under `skills:`.
- `tools/<name>.ts` — a project tool, registered under `tools:`
  (`references/kortix/tools.md`).
- `extensions/` — OpenCode plugins and pi extensions, registered under
  `extensions:`.
- `memory/` — the project brain (`kortix-memory` skill).
- `AGENTS.md` — instructions every agent reads.

A session runs one harness, **OpenCode** or **pi** (`<harnesses>` below).
Both run the same agents, compiled from `kortix.yaml`. A `kortix_version: 3`
session reads no `harnesses/`, `.kortix/`, `.opencode/` or `.pi/` folder.
Those folders belong to versions 1 and 2, which run as before
(`references/kortix/kortix-yaml-v2.md`).

Paths under `references/` below are relative to this skill's directory.
`kortix skills get kortix-system --full` prints every one of them.

A large manifest splits across files: the root lists `imports:` (YAML files
or directories), and each imported file declares `agents`, `skills`, `tools`,
`commands`, `extensions`, `connectors`, `apps`, `triggers` or `imports`. The
platform merges them into one manifest. A feature folder can hold its own
agents, prompts, commands, skills and triggers — see
`references/kortix/kortix-yaml.md` → Split the manifest by topic.
</overview>

<harnesses>
## The harness — check it before you change agent behavior

A harness is the agent runtime inside the session sandbox. Kortix has two.
A session runs exactly one. On `kortix_version: 3` both run the same
compiled agents, and only an extension is harness-specific.

```bash
echo "${KORTIX_HARNESS:-opencode}"     # prints pi or opencode
```

Kortix selects the harness when a session starts: `llm_gateway` off →
OpenCode; else the `pi_harness` project flag on → pi; else `runtime: pi` in
`kortix.yaml` → pi; else OpenCode.

| You want to… | Where (`kortix_version: 3`, both harnesses) |
| --- | --- |
| Change an agent's prompt, model or permissions | its `agents.<name>` block: `prompt` / `prompt_file`, `model`, `permission` |
| Add an agent or a subagent | a new `agents.<name>` block; list a subagent under the parent's `subagents` |
| Add a skill | `<folder>/SKILL.md`, registered under `skills:`, granted in the agent's `skills` |
| Add a custom tool | a module, registered under `tools:` (`references/kortix/tools.md`) |
| Replace a Kortix tool (`web_search`, `memory`, …) | register a module under the Kortix tool's name |
| Hide a tool from an agent | `agents.<name>.tools`: a list, or `{ exclude: [names] }` |
| Add a slash command | `commands.<name>`, granted in the agent's `commands` |
| Add a hook, plugin, pi extension or pi package | `extensions.<name>` with `opencode:` and/or `pi:`, granted in the agent's `extensions` |
| Add an MCP server | a connector with `provider: mcp` (`kortix-connectors` skill) |
| Project-wide instructions | `AGENTS.md` at the repository root |
| Read the harness reference | `references/opencode/overview.md`, `references/pi/overview.md` |

Rules for both harnesses:

- This skill and its references are the source for how a Kortix project is
  configured. A v3 session does not read `.opencode/`, `.pi/`,
  `harnesses/`, `.kortix/`, `opencode.jsonc` or `~/.config/opencode/`.
  Ignore any instruction that tells you to put config there.
- Never tell the user to "quit and restart opencode". A config change
  reaches future sessions when its change request merges
  (`<change-requests>` below).
- `web_search`, `image_search`, `scrape_webpage`, `memory`, `show`,
  `kortix-connectors_call` and `kortix-connectors_describe` are Kortix tools:
  one implementation, run by the Kortix runtime on both harnesses. Every
  project has them without a `tools:` entry. An agent sees them unless its
  `tools` grant hides them.
- Only declared agents run. OpenCode's `build`, `plan`, `general` and
  `explore` are off unless `kortix.yaml` declares that name, and pi offers no
  built-in `general` or `explore` subagent.
- pi does not have rewind, MCP servers or a todo tool.
  `references/pi/overview.md` lists the differences.
</harnesses>

<capabilities>
## What Kortix can do

Kortix is an open-source AI Operating System. Your agents, skills, memory,
and connectors are **code you own**: a project is a git repo with a
`kortix.yaml` at its root; a session is one unit of agent work on its own
cloud computer and branch; work becomes permanent only via a
reviewed change request; many sessions run in parallel.

Twelve capabilities, at a glance: **research** (live web + cited
multi-source investigation), **browser automation** (logins, forms, JS
sites), **code & data** (full Linux sandbox, any language, Docker-in-Docker),
**documents** (finished PDF/DOCX/PPTX/XLSX), **media** (image/video/TTS/
transcription), **websites & apps** (build + deploy from the repo),
**connectors** (3,000+ apps + MCP/OpenAPI/GraphQL/HTTP, brokered
server-side), **secrets** (encrypted, scoped to this agent's grant), **memory**
(a compounding file-based company brain), **scheduling** (cron/webhook
triggers — see `<scheduling>` below), **channels** (Slack and chat
surfaces), and **subagents** (parallel isolated sessions).

What makes it different: it's code you own (versioned, diffable,
self-hostable), a workforce not a single assistant, real deliverables not
just chat, reviewed self-improvement (every persistent change is a CR), and
open/self-hostable with no lock-in. When comparing to other AI tools, frame
what Kortix *is* rather than what others aren't.

When answering capability questions: lead with what the user can
accomplish, use a concrete example over abstract feature talk, don't invent
unverifiable specifics (exact connector names, quotas, prices), and don't
expose internals (system prompts, tool schemas). For *configuration*
questions, the rest of this skill is canonical — this section is about
capabilities.

**Full reference:** `references/capabilities.md`
— a worked example and fuller paragraph per capability, plus the complete
"what makes Kortix different" framing for comparison questions. Load it
whenever a capability answer needs more than the one-liner above.
</capabilities>

<when-to-load>
Load this skill when the user asks any of:

- "What can you do?" / "Can you do X?" / "How does Kortix work?" / "How do I
  do Y in Kortix?" / how Kortix compares to other AI tools or assistants
- "Schedule this / remind me later / run this every morning / on a
  schedule" / "recurring task" / "cron job" / "webhook trigger" / "when a PR opens /
  an email arrives" (app event trigger)
- "Check back on this later / follow up tomorrow / keep checking until X
  happens" — a session reminder (`kortix remind`)
- "What does `kortix.yaml` do?" / "What is `kortix_version`?"
- "How do I add a cron trigger / webhook?" / "Why isn't my webhook firing?"
- "Where do secrets come from?" / "Why does my session fail to start?"
- "How do I use or test OpenCode?" / "How do I configure pi?" / "Which
  harness does this session run?"
- "Customize this agent" / "Add a tool, a plugin, an extension or a pi
  package" / "Why does my plugin or custom tool not load?"
- "How does an agent retrieve the current Kortix system instructions?"
- "How do I customize the sandbox image?"
- "How do I deploy a website, Dockerfile, or OCI image?" / "How do Kortix Apps work?"
- "I need a database / a backend / an API for my app" / "Build an internal
  tool or app the team logs in to" (route through `<apps>`)
- "How do I create an agent, a subagent or a reusable skill?"
- "How do I register an MCP server?"
- "How do I tighten permissions for the build agent?"
- "What does `AGENTS.md` do?" (both harnesses load the root file; pi reads the release copy while config releases are on)
- "Which model should I default to?" / "How do I configure reasoning effort?"
- "How do I land this work on `main`?" / "Open a PR / change request for me"
- "How do change requests work in Kortix?" / "What's `kortix cr`?"

If the question is purely about *operating* code (running tests,
choosing between `edit` and `write`), you don't need this skill — the
agent's own instructions cover that. This skill is the **configuration
+ platform** reference.
</when-to-load>

<cli>
You are running inside a Kortix session sandbox. The **`kortix` CLI**
is on `$PATH` (`/usr/local/bin/kortix`) and pre-authenticated against
this exact project — a project-scoped token is already injected as
`$KORTIX_TOKEN`, with `$KORTIX_API_URL` pointed at the right host.
You can run `kortix …` from any shell with zero setup.

**Reach for the CLI** whenever the user asks for something that touches
Kortix cloud state — not just files in the repo. Examples:

| The user says… | Use… |
| --- | --- |
| "list / read project secrets" | `kortix secrets ls` |
| "set / unset a secret" | `kortix secrets set NAME=VALUE`, `kortix secrets unset NAME` |
| "pull / push my `.env`" | `kortix env pull`, `kortix env push --from .env` |
| "what sessions are running right now?" | `kortix sessions ls` *(add `--json` to parse)* |
| "show all parallel agents at a glance — what's everyone doing?" | `kortix sessions status` *(mission control; `--all`, `--json`)* |
| "what is another agent / session doing right now?" | `kortix sessions log <id>` *(read-only peek; `--json`)* |
| "talk to / pick a session to interact with" | `kortix sessions chat` *(picker)* · `kortix sessions chat <id> --prompt "…"` *(one-shot)* |
| "spawn another session / subagent to do X" | `kortix sessions new --prompt "X" --json --wait` *(capture session_id)* |
| "label / classify a session, or find sessions by label" | `kortix sessions new --label <l> --meta k=v …` · `kortix sessions update [<id>] --label <l> --unlabel <l> --meta k=v --unmeta k` *(no id = this session)* · `kortix sessions ls --label <l>` |
| "restart / kill session `<id>`" | `kortix sessions restart <id>` / `kortix sessions rm <id>` |
| "fire the daily-digest trigger" | `kortix triggers fire daily-digest` |
| "check back on this later / keep checking until it's done" | `kortix remind "…" --in 24h --every 1h` · `kortix reminders ls|pause|resume|rm` |
| "show open change requests" | `kortix cr ls` |
| "who am I? what project is this?" | `kortix whoami`, `kortix projects info` |
| "turn on / off a feature flag (Reminders, Meta Agent, …)" | `kortix projects features` · `kortix projects features enable <flag>`. The internal-only flags (`session_log`, `session_log_restore`) are Kortix-managed: listed only while on; only Kortix changes them. |
| "rename the project / change its icon or default branch" | `kortix projects set --name … --icon … --branch …` |
| "which models can this project use? set the default model" | `kortix models ls` · `kortix models default <model>` · `models enable|disable <id>` |
| "change the default agent / an agent's scope or config" | `kortix agents default <name>` · `kortix agents scope <agent> [--secrets …] [--connectors …] [--apps …]` · `kortix agents config <agent>` |
| "stop / wake a session, share it, or publish a preview link" | `kortix sessions stop|start <id>` · `sessions share <id> --mode …` · `sessions links <id> create --port 3000` |
| "queue a prompt for later / see or reorder the queue" | `kortix sessions chat <id> -p "…" --queue` · `kortix sessions queue <id> ls|now|rm|hold|release` |
| "approve / deny a pending connector call" | `kortix sessions approvals <id> ls|approve|deny` |
| "call Gmail / a CRM / any connector from an App (a backend included) or a script" | `@kortix/sdk` through the connector gateway, never a raw provider key · `kortix system-skills get kortix-connectors` (**From apps and backends**) |
| "edit files in another session's sandbox" | `kortix sessions files <id> ls|write|mv|rm|find` |
| "what needs review? approve / reject / request changes" | `kortix review ls` · `kortix review act <id> approve` · `kortix cr request-changes <cr> --message` |
| "show me every app event trigger" / "what listens to <app>?" | `kortix triggers ls --type event` (grouped by app) · `kortix triggers ls --connector <slug>` · web: Triggers → **App events** |
| "when X happens in <app>, do Y" (new email, PR, issue, calendar event, Slack message). Beta: needs the project flag `event_triggers` (`kortix projects features enable event_triggers`; a `403 feature_disabled` means it is off) | `kortix triggers events --apps` → `triggers events --app <app> [--event <TYPE>]` (browse events before any connector) → `triggers events --connector <slug> --event <TYPE>` → `triggers add … --type event … --apply` · playbook: `references/scheduling.md` → App event triggers |
| "edit a trigger live (schedule, conditions, agent, model)" | `kortix triggers set <slug> --cron … --filter k=v` · `triggers add … --apply` |
| "which tools does this project have? hide / change a Kortix tool" | the `tools:` registry and each agent's `tools` grant in `kortix.yaml` · `kortix tools eject <name>` *(`references/kortix/tools.md` has the checklists)* |
| "who is in the account / invite someone / manage groups" | `kortix members ls|invite` · `kortix groups …` · `kortix access requests ls` |

**Everything is scriptable — drive Kortix like the dashboard.** Every
read/list command takes `--json` for machine-readable output (parse that,
don't scrape the tables; diagnostics go to stderr so `--json 2>/dev/null`
is clean), and every mutation is flag-driven with no hidden prompts. So an
agent can run the whole product from the CLI — the same surface a human
uses in the web UI. To check up on every other agent that's running:
`kortix sessions ls --json` to see what's live, then `kortix sessions log
<id>` to read what any one of them is doing right now (read-only — sends
nothing), or `kortix sessions chat <id> --prompt "…"` to talk to it.

**Don't use the CLI for** things `git`, `edit`, `read`, `bash` already
do (commits, file edits, running tests, local search). The CLI is the
cloud-state surface; everything else is local.

**Token scope reminder.** The CLI's token (`$KORTIX_TOKEN`, a
`kortix_pat_…` bound to this session) is project-scoped — it cannot
enumerate other projects or hit account-level routes, and a route that
names a session accepts only this session. Trying `kortix projects ls` from
inside the sandbox returns 403; that's intentional. Use `kortix projects info` to inspect **this** project.

**Secret capability discovery.** `$KORTIX_SECRET_CAPABILITIES` contains a
value-free JSON catalog for this session. Check it before asking for a
credential. It lists only secrets allowed by both the agent grant and session
scope. Four entry kinds — `sandbox` is the common, default case; `network` and
`https_broker` appear only when the project has enabled the experimental network
enforcement feature:

- `sandbox` — the named environment variable holds the REAL value. This is the
  default kind. Treat it as radioactive: never print it, never echo it, never
  write it to a file.
- `network` — appears only under the experimental network enforcement feature.
  The named environment variable holds a HANDLE, not the value. Use
  the variable exactly as you would use the real credential (header, query
  string, body). Kortix swaps the handle for the real value OUTSIDE the sandbox,
  and only on the `hosts` the entry lists, over HTTPS. Sent anywhere else the
  handle arrives as a literal string and the request fails. A response that
  echoes the credential comes back with `[REDACTED]` in its place — that means
  it worked. An empty reply or a connection error on a listed host is a REAL
  failure. The value is not in this sandbox in any form: do not search for it,
  do not ask the user for it. The entry's `notes` carry the full rules.
- `https_broker` — appears only under the experimental network enforcement
  feature. Use `kortix secrets call IDENTIFIER URL [options]`; Kortix adds the
  value server-side only after the request matches the stored policy. This is
  also the fallback when a request cannot be relayed transparently.
- `kortix_service` — spent only by its named service, such as a connector or
  the LLM gateway. It has no sandbox presence at all.

Never print or return a secret value or a handle. Use `kortix secrets ls
--json` when you need the complete stored policy.

**Getting a credential — never punt to the dashboard.** If the human already
gave you the value (pasted in chat, in a file, "use this key"), **store it
yourself in the same turn** with `kortix secrets set NAME=-`
(`--scope connector` for a connector credential) —
no link, no second entry, never echo it back. A `403` means your agent lacks
secret-write permission: fall back to a link. If you do NOT have the value,
**mint a setup link and surface the URL in the same turn** with
`kortix secrets request` / `kortix connectors connect`. The human gets a
fill-in modal (web) or a tappable link (Slack). Never tell them to "open
Customize → Connectors". Full playbook in the **credentials-and-setup-links**
reference below.

**Exception — connecting Slack itself.** Slack is a built-in channel, not a
connector or a secret. `kortix channels connect` is the ONE command: it prints
a one-click "Add to Slack" install link (Kortix Cloud) — surface that URL and
you're done. No manifest, no bot token, no secret-intake link. Details in the
`kortix-slack` skill.

**Full reference:** `references/kortix/kortix-cli.md`
— every command, every flag, every env var, common workflows. Load it
when you need exact syntax.
</cli>

<mcp-client>
## Connect an MCP client

Kortix has one hosted MCP server: `https://api.kortix.com/v1/mcp` (on another
deployment, `<api origin>/v1/mcp`). An MCP client (Claude, ChatGPT, Cursor,
VS Code, Codex) that adds the URL signs the person in with OAuth and acts as
them, with their permissions, in every project they can open. Nothing to
install. Claude Code:

```bash
claude mcp add --transport http kortix https://api.kortix.com/v1/mcp
```

A client without OAuth sends a personal access token as
`Authorization: Bearer kortix_pat_…` (`kortix tokens new <name>`). A person
revokes an OAuth client with `kortix tokens apps rm <client-id>` or in
Settings → Personal access keys → Connected apps. A connected app cannot mint
personal access tokens, gateway keys, SCIM tokens, OAuth clients or service
accounts. Client-by-client steps: `https://kortix.com/docs/connect/mcp`.

The server also exposes a project's connectors, the `kortix connectors` CLI as
MCP tools: `list_connectors` → `search_connector_actions` →
`describe_connector_action` → `call_connector` (pass `reason` on a write whose
args are only ids; a `pending_approval` result carries a link the person
opens, then call again with the same args). `connect_connector` returns the
link that connects an account. `upload_connector_attachment` stages a file.
`search_connector_apps`, `add_connector` and `remove_connector` change which
connectors the project has.

The `kortix` MCP tool runs the real CLI as the person: `args` is the argv after
`kortix` (`["secrets", "ls", "--json"]`), `project_id` and `session_id` set the
context, and the result is `exit_code`, `stdout` (`json` for `--json` output), `stderr`. Discover with
`["--help"]` and `["<group>", "--help"]`. Prefer the first-class tools for
sessions, sandbox files and connectors. The tool refuses `--host`, `hosts`,
`login`, `logout`, `init`, `ship`, `update`, `uninstall`, `self-host`, `tui`,
`connect`, `chat` without `--prompt`, `token`, `env pull|push`, `apps deploy`
(a local directory: use `run_command` in a session sandbox), with the reason
and the alternative. `read_skill` with
`project_id` lists the project's own skills.
</mcp-client>

<apps>
## Kortix Apps — sites, servers and backends

An **App** is a project-scoped thing with one stable Kortix URL. Kortix runs it
as releases, machines and volumes:

- A **release** (`vN`) is immutable: an artifact plus its resolved config. A
  failed release never replaces the live one. A rollback is a new release from
  an older one.
- A **machine** runs a release for one process group. It keeps its id across
  releases; each release replaces its box, so its root disk resets.
- A **volume** is a persistent disk. It outlives every release and machine,
  with daily snapshots, restore and fork.

Every App is the same primitive. Clients branch on `capabilities`, never on a
type. `labels` (for example `backend`) only group and filter Apps.

- A **static App** (`--type static`) is files that Kortix serves itself: no
  machine, no cold start, no compute bill, instant rollback. Build a Vite,
  React, or exported Next.js App here and deploy its output directory.
- A **server App** (`--type dockerfile`, or `--image`) runs machines. It runs
  **always on** (the default, 24/7) or **on demand** (`--on-demand`: stops
  when idle, wakes on the next request). An always-on App bills its machines
  24/7; an on-demand App bills only while awake. Apps have no monthly budget:
  account credits pay. `--budget` is retired.
- A **backend** (database, server functions, realtime, file storage) is a
  server App with a volume. `kortix apps launch --template convex`
  writes and deploys a self-hosted Convex backend (`backend`, data on a volume) and
  an admins-only dashboard (`backend-dashboard`). Its code lives in
  `apps/backend/convex/` and ships with `npx convex deploy`.

Apps are generally available in every project. Use Apps directly; no feature
flag or enablement request is required.

New Apps are private. Use `kortix apps access <app>` to select creator-only,
whole-project, restricted member/group, public, or password access. Never store
an App password in `kortix.yaml`.

Each App's code lives in its own folder, `apps/<slug>/` by default (`path` is
free-form; group by team or topic when that fits better). Deploy that folder:

```sh
kortix apps deploy apps/storefront/dist --type static --spa
kortix apps deploy apps/api --type dockerfile --on-demand --command '["bun","run","start"]' --port 3000
kortix apps deploy --image ghcr.io/acme/api:1.4.2 --command '["/app/server"]' --port 8081
kortix apps launch --template convex
kortix apps releases api          # vN, status, strategy; the live one marked
kortix apps machines api          # machines per process group, their volumes
kortix apps scale count api 2 --process worker
kortix apps volumes snapshot backend data
kortix apps access storefront --mode restricted --members <member-id> --groups <group-id>
```

For a repeatable deployment, declare an `apps:` map in `kortix.yaml`
(the App's release config: `processes`, `http_service`, `services`, `mounts`, `vm`,
`deploy`, `labels`), then run `kortix apps deploy --manifest-app <name>`, or a
bare `kortix apps deploy` for every block. The manifest stores non-secret
environment values and maps runtime environment keys to **project secret
identifiers**. It never stores secret values.

A server App supports HTTP services (each on its own host), HTTP streaming,
SSE and WebSockets. Apps do not support TCP or UDP services, private
networking between Apps, private registries, or custom domains yet.

**Build a product: what to create.**

| The user wants | Build |
| --- | --- |
| A website or UI with no stored data | A static App |
| An app with data, login or realtime | `kortix apps launch --template convex` + a static App that uses it (`kortix apps link <ui> --uses backend`) |
| A backend (data, functions, realtime) or an API only | The `convex` template, or a server App with a volume |
| A call to an external system from an App | The connector gateway (`kortix-connectors`) |
| Agent work on a schedule or an event | `<scheduling>` here, `references/scheduling.md` |

Load the `kortix-apps` system skill before you deploy or operate an App, and
before you write Convex code.
**Full reference:** `references/kortix/apps.md` — workload selection, manifest
fields, every lifecycle command, run modes and cost, ignore rules, secrets,
cold starts, rollback, retention, limits, and failure handling.
</apps>


<marketplace>
The **Kortix Marketplace** is the project skill library and the normal way to
discover, install, inspect, and update optional capabilities. Search it before
creating a new skill from scratch.

Use the consumer CLI surface:

```sh
kortix marketplace search <query> --json
kortix marketplace show <name> --json
kortix marketplace install <name> --project <project-id>
kortix marketplace status --project <project-id> --json
kortix marketplace updates --project <project-id> --json
kortix marketplace update <name> --project <project-id>
kortix marketplace update --all --project <project-id>
```

The web equivalent is the project's Marketplace/Customize surface. Normal
agents should not use `kortix registry build/validate/publish`; those are
developer-authoring tools for producing registries, not for consuming skills in
a project.

Marketplace installs are git-native: installing or updating writes files into
`skills/...` (agents into `agents/`), updates `registry-lock.json`, and commits the
change to the project repo. Installed state and update detection come from the
lock file's target paths and content hashes, not from a hidden database flag.
`update --all` uses one server-side batch update so all outdated skills land in
one commit.

**Full reference:** `references/kortix/marketplace.md`
— load it whenever you need to pick skills, explain installed/update status,
debug marketplace behavior, or decide whether to create a new skill.
</marketplace>

<authoring-skills>
## Authoring a new skill

A skill is a **directory** with `SKILL.md` at its root — frontmatter
(`name`, `description`, required) plus a markdown body, conventionally
at `skills/<name>/SKILL.md`. The directory name must equal `name`. Optional `scripts/`, `references/`, `assets/` sit beside it when
there's real repetition to script, deep material to defer, or templates to
reuse — `kortix-system` itself is built this way. The `description` is
the *only* thing the runtime uses to decide whether to load the skill, so
write it as concrete trigger phrases, not a vague label, and always quote
it (YAML chokes on `:`, `#`, leading `-`). Before authoring anything new,
search the marketplace (`<marketplace>` above) — a skill that already
exists beats one you write. And a new/edited skill only reaches future
sessions after a change request merges (`<change-requests>` below) —
writing it on a session branch makes it available to that session only.

A skill reaches an agent in two steps: register it under `skills:` in
`kortix.yaml` (name → folder), then grant it in that agent's `skills`. An
agent with no `skills` key loads no skill. A `SKILL.md` that no registry entry
names is never visible. A project skill name must not start with `kortix-`:
that prefix belongs to the managed Kortix skills, which every session receives
at boot and an agent grants by name. Do not edit them in the repo.

**Full reference:** `references/authoring-skills.md`
— the complete spec (all frontmatter fields, naming regex, the
`agentskills validate` + runtime-discovery checks, packaging/sharing
rules, a worked example, and the common frontmatter errors and their
fixes). Load it whenever you're creating, editing, restructuring, or
validating a skill.
</authoring-skills>

<scheduling>
## Scheduling — running work later, on a schedule, or on an event

Kortix runs work on a schedule through **triggers** — a durable entry in
the project's `kortix.yaml` (`triggers:`). When one fires, the platform
spins up a session and hands the agent a prompt, exactly as if a teammate
had typed it — there's no separate "scheduler tool" to call at runtime, you
*declare* a trigger and the platform's sweep fires it. A trigger may live in
`kortix.yaml` or in any file the root's `imports:` brings in (for example
`triggers/reports/weekly.yaml`); before adding one, check where the
project keeps its triggers and follow that layout.

Decide the mechanism first:

- **Follow up on THIS task later** — did the email arrive, is the deploy
  green, did they reply → a **reminder**, not a trigger:
  `kortix remind "Did the vendor email arrive? If yes, act on it, then remove this reminder." --in 24h --every 1h`.
  One command, no `kortix.yaml` change. It re-prompts THIS session (full
  context) at each fire, waking it if parked, until you remove it. `--in`/
  `--at` alone fires once; `--every` (≥5m) or `--cron` repeats. A reminder
  is a trigger scoped to one session: it lives in the database and pauses
  itself if the session is deleted. This is the native mid-task
  pause/resume: set a reminder, end the turn. Always remove a recurring
  reminder once its condition is met — every fire is a model turn.
  Reminders are a per-project feature flag (`reminders`, off by default).
  If `kortix remind` answers "Reminders is not enabled for this project",
  tell the user and name the switch (`kortix projects features enable
  reminders`, or Settings → Feature flags); turning it on is their call, not
  yours. Until then, use a one-off `run_at` trigger instead.
- **Recurring project work** anyone should see (daily digest) →
  `type: cron` + `cron` (6-field croner) + `timezone` in `kortix.yaml`.
- **One-off project job** not tied to this session → `type: cron` + `run_at`.
- **Reacts to an event in a connected app** ("when a PR opens", "when an
  email arrives", "when an issue changes") → `type: event` + `connector` +
  `event`. `connector` is the profile; add `account: <label>` only to pick
  one of several shared accounts on it. `source` names the event source
  adapter and defaults to the connector's provider; Composio is one adapter.
  The event id belongs to the adapter. Kortix subscribes for you: no
  webhook, no secret, no signature.
  Use `type: webhook` + `secret_env` only for a system that has no app
  connector.

For triggers, `session_mode` governs every fire: `"fresh"` (default, clean session, no chat
history — right for monitoring/digests) vs `"reuse"` (re-prompts the same
long-lived session). Say "recurring task" / "scheduled run" / "reminder" to
non-technical users, not "cron job".

Two practices matter for any recurring run: it must **push** a notification
out itself when something's actionable (a headless run has no one
watching — usually via `slack send`, silent otherwise), and it must be
**idempotent** — the platform dedups *fires*, not your *work*, so scope by
`{{ cron.last_fired_at }}` and track what's already been handled.

**Full references:**
- `references/kortix/kortix-yaml.md`
  — the complete `triggers:` field schema (cron/webhook/event fields, prompt
  template variables, webhook signature + response codes, `session_mode`,
  the project-wide `triggers_paused` kill-switch).
- `references/scheduling.md` — the
  operational playbook: full cron cheat-sheet + gotchas (DOM+DOW OR-not-AND
  trap, no exact-minute gates), fresh-vs-reuse guidance, notifying/
  idempotency practices in depth, the pause-and-wait re-fire pattern,
  worked examples, a pre-ship checklist, and the **App event triggers**
  playbook (autonomous setup recipe, statuses, noise control).
- `references/kortix/kortix-cli.md`
  — the `kortix triggers ls/info/fire/enable/disable/events/add/set` and
  `kortix reminders` command reference.
</scheduling>

<continual-harness>
## Continual harness — the project refines its own scaffolding

Everything that shapes agent behavior in this project — agent prompts,
sub-agents, skills/tools, memory — is the **harness**, and it lives in git:
`kortix.yaml`, `agents/`, `skills/`, `tools/`, `extensions/` and `memory/`. Kortix treats the harness as continuously improvable
from trajectory evidence, on two loops:

1. **In-session refinement (self-invoked)** — every agent runs the
   four-pass protocol from the `kortix-harness-refinement` skill over its
   own recent turns the moment a failure signature costs it twice (and as
   a checkpoint on long sessions). Edits apply in place — they take
   effect next turn — committed `harness: …` to the session branch, with
   one CR kept updated toward `main`.
2. **Cross-session reflection** — the `harness-reflector` agent (daily
   cron trigger, on by default) fans out read-only `session-reviewer`
   sub-agents, one per recent session, to work through full session
   histories; it aggregates their findings, refines the shared harness,
   and opens a `harness: …` CR against `main`.

Any agent may also invoke the protocol itself when a failure signature
costs it twice — load `kortix-harness-refinement`
(`kortix skills get kortix-harness-refinement` if it is not on disk)
for the failure signatures, the four passes, and the guardrails (never
edit managed `kortix-*` skills, never merge your own harness CR, no-op
is valid).
</continual-harness>

<change-requests>
**This is the single most important rule for any agent running in a
Kortix session: if you want your work to land on `main`, you MUST open
a change request (CR).**

Sessions run on ephemeral branches (`session-<id>`). The session VM
dies when the session ends; the branch persists in git, but
**nothing on it reaches `main` automatically.** A session-branch
commit is invisible to every future session — they all boot from
`main`. The only sanctioned merge path is a CR — the user reviews
the diff in the dashboard or CLI and merges it (or asks for changes,
or closes it).

### The mandate

When you, as an agent, have changes you believe should persist:

1. **Sync with the base first.** `main` may have advanced while you
   worked (other sessions merge CRs, the dashboard commits config):
   ```sh
   git fetch origin && git log HEAD..origin/main --oneline
   ```
   If the base moved, rebase onto it (`git rebase origin/main`) and
   resolve any conflicts NOW — a CR whose head is behind or in conflict
   with base can't be applied, and the conflict is yours to fix, not
   the reviewer's.
2. **Commit on the session branch.** Small, working commits. Never
   rewrite history that isn't yours. Run `kortix validate` first, and
   never commit a large binary or generated file (see `<gotchas>`:
   keep big static assets out of Git).
3. **Push the branch.** This step is NOT optional — a commit that
   never leaves the sandbox produces an empty, un-appliable CR:
   ```sh
   git push origin HEAD
   ```
   If the push is rejected because the remote session branch moved
   (the platform can advance it to the latest base), run
   `git fetch origin` then `git push --force-with-lease origin HEAD`.
   Force-pushing is accepted ONLY for your own session branch; the
   proxy refuses it for `main` or anyone else's branch, so there is
   nothing to be careful about — it simply will not go through.
4. **Open a CR.** From inside the sandbox the CLI reads
   `$KORTIX_BRANCH_NAME`, `$KORTIX_SESSION_ID`, and `$KORTIX_TOKEN`
   automatically:
   ```sh
   kortix cr open \
     --title  "Short, imperative summary" \
     --description "What changed and why. Test plan. Risks."
   ```
   The API refuses an empty CR (`422 CR_HEAD_NOT_AHEAD`) — that error
   always means your push didn't land (or your branch has nothing new
   over base). Fix the push and retry; don't work around it.
5. **Verify the CR carries your diff.**
   ```sh
   kortix cr diff <n>
   ```
   If it shows no changes, your push didn't land — push and re-check
   the SAME CR (the diff recomputes live from the refs). Never open a
   duplicate CR for the same work.
6. **Surface the CR to the user.** Print the CR number so they can
   review:
   ```sh
   kortix cr ls
   ```
7. **Wait.** The user merges via dashboard, CLI (`kortix cr merge
   <n>`), or asks for changes. *You do not merge your own CRs.*

### Don't bypass this

- **You cannot push to `main` directly — the platform refuses it.**
  A session's git credential may write exactly one ref: its own
  session branch. A push to `main`, to another session's branch, to
  any other branch, or to a tag comes back as
  `! [remote rejected] <ref> (a session may only push its own
  branch ...)`. That is not a bug to work around; it is the review
  contract. Commit on your branch, push it, open a CR.
- **You cannot merge your own CR.** The API refuses it with
  `CR_SELF_MERGE_REFUSED`. A person merges it.
- **Don't paper over with "I committed it on my branch."** That isn't
  persistence. The session branch dissolves; only `main` survives.
- **Don't ask the user to copy-paste files out of the session.** The
  CR exists precisely so they don't have to.

### How a CR composes with the rest of the system

| Surface       | How it interacts with the CR                                                              |
| ------------- | ----------------------------------------------------------------------------------------- |
| Sandbox       | CR is opened from inside the sandbox via `$KORTIX_TOKEN`. Branch tip is the session HEAD. |
| Dashboard     | Renders the CR — title, description, diff, merge preview, conflict markers.               |
| CLI           | `kortix cr ls / show / diff / open / merge / close / reopen` — full life-cycle locally.   |
| `kortix.yaml` | Edits to triggers / env land via CR like any other file.                                  |
| Skills        | New skill files reach future sessions **only** after a CR merges. Managed Kortix system skills also receive the deployed host overlay. |
| Triggers      | Cron / webhook trigger edits reach the scheduler **only** after the CR merges to `main`.  |

Full reference: `references/kortix/change-requests.md`.
</change-requests>

<contract>
The boundary between project config and runtime config (`kortix_version: 3`):

| Surface | File | Read by |
| --- | --- | --- |
| Registries and agents | `kortix.yaml` and the files it imports | Kortix, which compiles them for the session |
| Prompts, skills, tools, extensions | the repository files `kortix.yaml` names | the session's harness, through the compiled config |
| Project instructions | `AGENTS.md` | both harnesses |

A v3 session reads only the compiled manifest. It reads no harness config
folder, `opencode.jsonc` or pi `settings.json`. Code that changes one harness
is an `extensions` entry with one implementation per harness. `runtime:`
selects the harness. Dashboard edits to triggers and env round-trip through
`kortix.yaml`.
</contract>

<canonical-schema>
## The canonical manifest schema — one URL, always correct

Check the top `# yaml-language-server: $schema=...` line in `kortix.yaml`.
That URL is the public, versioned JSON Schema, generated from
`@kortix/manifest-schema` (the same package that backs `kortix validate` and
the CR-merge gate):

| URL | Covers |
| --- | --- |
| `https://kortix.com/schema/kortix.v3.schema.json` | `kortix_version: 3` (opt-in) |
| `https://kortix.com/schema/kortix.schema.json` | All published versions; dispatches on `kortix_version` |
| `https://kortix.com/schema/kortix.v2.schema.json` | `kortix_version: 2`, the version new projects are created on |
| `https://kortix.com/schema/kortix.v1.schema.json` | `kortix_version: 1` (legacy `[[agents]]` array + `[[channels]]`) |

`kortix schema --version 3` prints the same document locally, and
`kortix schema --url` prints only the URL. The schema is the structural
spec. `kortix validate` is the behavioral one: it also checks cross-field
rules, for example that every grant names a registered skill, tool, command
or extension and that `default_agent` names a declared, enabled, non-subagent
agent.

**v3 in one paragraph:** the project registers `skills`, `tools`,
`commands` and `extensions` by name; each `agents.<name>` block holds the
agent's behavior (`description`, `mode`, `prompt` or `prompt_file`, `model`,
`permission`, …) and enables registered things by name. An omitted grant is
none, except `tools` (every tool) and `permission` (`allow`). Unknown keys
are errors. The full key reference is `references/kortix/kortix-yaml.md`.
Version 2 is the version new projects are created on
(`references/kortix/kortix-yaml-v2.md`); version 1 is legacy. On request,
`kortix migrate` prints the v3 manifest for a v2 project, and
`kortix migrate --write` writes it.

</canonical-schema>

<agent-authorization>
## Per-agent governance — `agents:`

In `kortix_version: 3`, one `agents.<name>` block is the whole agent: its
behavior and what it may reach. Nothing is shared between agents.

```yaml
agents:
  release-bot:
    description: Ships releases.
    mode: primary
    prompt_file: agents/release-bot.md  # or prompt: "…", not both
    permission:
      bash:
        "*": allow
        "git push *": ask              # omitted permission is allow
    skills: [kortix-system]             # registered or Kortix skills (default: none)
    subagents: [reviewer]               # declared agents with mode subagent or all (default: none)
    commands: [release-notes]           # registered commands (default: none)
    extensions: [audit]                 # registered extensions (default: none)
    sandbox: ml                         # default environment for this agent
    connectors: [github]                # which connectors it may call (default: none)
    apps: [reports-dashboard]           # Kortix App slugs it may open when the App is restricted/private (default: none)
    kortix_permissions: [project.write, project.gitops.push]    # what it may do to the project — CLI, API, git (default: none)
```

**Three permission layers — never confuse them:**

| Layer | Key | Decides |
| --- | --- | --- |
| Tool policy | `agents.<name>.permission` | whether a harness tool call runs (`allow`), waits for a person (`ask`) or is refused (`deny`) |
| Kortix permissions | `agents.<name>.kortix_permissions` | which Kortix project actions the agent's token may take |
| Connector approvals | top-level `policy` / `policies` and a connector's own `policies` | whether a connector call runs, needs approval, or is blocked |

`permission.skill` and `permission.task` are errors: `skills` and
`subagents` write them. The dashboard agent editor, `kortix agents scope`,
`config`, `default` and `kortix secrets grant` edit v2 manifests only. On v3,
edit the block in `kortix.yaml` and open a change request.

**How the grant resolves at session start:**
- v3 and v2 (`kortix.yaml`) are **deny-by-default**: an omitted `connectors`/`secrets`/`skills`/`apps`/`kortix_permissions` (and in v3 `subagents`/`commands`/`extensions`) on a declared agent resolves to `none`, not `all`. `default_agent` is required and must resolve to a declared, enabled agent with mode `primary` or `all` — give it `connectors: all`, `secrets: all`, `kortix_permissions: all`, `skills: all` explicitly if it should keep full access.
- v1 (`kortix.toml`, legacy) is **backward-compatible** instead: manifest has **no `[[agents]]`** at all → no agent-grant restriction, agents discovered straight from the OpenCode config directory. Agent **is listed** → its `connectors`/`kortix_permissions` (default each = none if omitted). Manifest **has `[[agents]]` but this agent isn't listed** → default-deny for Kortix grants. The v1 default agent keeps **full access** only while `[[agents]]` is unadopted — the moment you add `[[agents]]`, declare the default agent too or it falls under the unlisted-deny rule.
- **You are the acting principal.** Effective = your `kortix_permissions` ∩ your **ceiling** (the IAM role an admin binds to your service account; with none bound, every grantable project permission). `all`, `"*"`, and any list containing `"*"` mean every permission, including `project.members.manage` and `project.delete`. The one exception is `project.credentials.issue` (`403 agent_human_only_action`): a token you mint would carry none of your permissions. The launcher's role is not an input. The human contributes "may run this agent" and their own personal resources (their connector connections, personal secrets, their computer) — only in their own **private** session, and only until someone else prompts it. Trigger and channel runs have no human behind them.
  - `project.read` in your own project is always granted.
  - When a call returns 403, read `code`: `agent_scope_insufficient` → the action is missing from your `kortix_permissions` (propose a CR); `agent_ceiling_insufficient` → an admin must raise your ceiling role; `agent_not_accessible` → the human may not run that agent; `agent_grant_escalation` → you tried to give an agent (yourself included) a permission, connector, secret or App you do not hold. Never claim an authority the code says you lack.
  - **You grant only what you hold.** Any agent grant you write — through the agent editor, the scope or secret-grant routes, or a CR you merge — may add only what your own effective grant holds. A person widens an agent beyond you. A push straight to the default branch also needs you to hold every grant; otherwise open a CR.
- Editing the manifest only takes effect once the **CR is merged** (read from the default branch). A CR that changes `agents.*` needs `project.agent.write`, `triggers` needs `project.trigger.create|update|delete`, `default_agent` needs `project.customize.write` — on top of `project.gitops.merge`. With `kortix_permissions: all` you hold them all and merge such a CR yourself. A push straight to the default branch needs `project.gitops.ref.any` plus all of those. A `503 CR_GOVERNANCE_UNVERIFIED` means the manifest could not be read; nothing merged, retry after `Retry-After` seconds. An older server answers `403 CR_AGENT_GOVERNANCE_CHANGE`; only a person can merge it there.
- Check what you hold with `kortix whoami --token-only`. If it says `none` right after a `kortix.yaml` change, the change broke your grant: revert it before anything else.
- Session environment precedence is explicit `sandbox_slug`, agent `sandbox`, project `sandbox.default`, then platform `default`. Triggers, schedules, and channels use the target agent's environment.

**Discovery contract:**
- Only the agents declared under `agents:` run. A prompt file alone is not
  an agent.
- Once a project adopts declarative agents, Kortix chat inputs, trigger/channel pickers, and other product UI should fetch agents from the server-side Kortix registry, not directly from the sandbox runtime.
- Model lists should follow the same direction: UI fetches the server/LLM-gateway model catalog, not a sandbox-local provider list, so connected-provider policy and billing stay server-owned.
- New projects use `kortix_version: 2`. A project keeps its version until
  someone migrates it on purpose; never change it unprompted.

**`kortix_permissions` — the grantable enum** (`kortix_cli` is the deprecated spelling, still accepted with a validation warning; project-scoped only; account-level admin actions
like `member.*` / `billing.*` / `project.create` can NEVER be granted to an agent. One project
action is **HUMAN_ONLY** — `project.credentials.issue`: it validates in the manifest, but an agent never holds it).
Run `kortix validate --scopes` to print this list:

```
project.read  project.write
project.cr.open  project.cr.merge          # opening a CR ≠ merging it (merge lands code on main)
project.session.read  project.session.start  project.session.stop  project.session.bindings.write
project.members.read
project.trigger.read  project.trigger.create  project.trigger.update  project.trigger.delete  project.trigger.fire
project.gateway.logs.read  project.gateway.spend.read  project.gateway.budget.set
project.agent.read  project.agent.write
project.skill.read  project.skill.write
project.command.read  project.command.write
project.file.read  project.file.write
project.settings.write  project.sandbox.write
project.model.read  project.model.write
project.gitops.read  project.gitops.push  project.gitops.merge
project.secret.read  project.secret.write
project.connector.read  project.connector.write  project.connector.connections.manage   # channels (Slack/meet/email) send + connect are gated here
project.app.read  project.app.write  project.app.deploy  project.app.admin   # admin: exec, volume restore/destroy, admins-only services
project.review.read  project.review.submit  project.review.act
```

`kortix validate` validates `agents:` — rejecting unknown /
account-scoped actions — and prints each agent's resolved scope. Use `kortix validate --scopes`
to see the full enum.
</agent-authorization>

<references>

<reference path="references/capabilities.md">
  The full capabilities reference behind the `<capabilities>` summary
  above: a worked-example paragraph per capability (research, browser,
  code/data, documents, media, websites/apps, connectors, secrets,
  memory, scheduling, channels, subagents, models), "What Kortix is," and
  "What makes Kortix different" for comparison questions. Load whenever a
  capability question needs more than the one-liner in SKILL.md.
</reference>

<reference path="references/kortix/credentials-and-setup-links.md">
  How to get a credential — an API key, or an app connected. A value you
  already have (the human gave it in chat) is stored directly with
  `kortix secrets set`; a value you lack is requested with a
  short-lived **setup link** instead of punting the human to the dashboard. Covers
  the two link kinds (secret intake / Composio connect), how to mint each
  (`kortix secrets request` / `kortix connectors connect`), what the human sees
  (web modal vs Slack link), how to verify it
  landed, and the security model. Load this whenever you hit "I need an API key /
  I need this app connected" — it is the canonical, autonomous flow.
</reference>

<reference path="references/kortix/kortix-cli.md">
  In-depth `kortix` CLI reference. Every subcommand (login, hosts,
  projects, secrets, env, sessions, triggers, cr, init, update,
  uninstall), every flag, every env var the CLI reads. Includes the
  project-scoped token model and what the CLI can do **from inside a
  session sandbox** (where `KORTIX_TOKEN` + `KORTIX_API_URL` are
  pre-injected so `kortix sessions ls`, `kortix secrets set FOO=bar`,
  `kortix cr ls` all work out of the box). Load this when you want to
  drive the Kortix cloud from a terminal or agent.
</reference>

<reference path="references/kortix/apps.md">
  Kortix Apps deployment and operations reference. Covers static hosting and
  server Apps (bundle, Dockerfile, and OCI workloads); always-on and on-demand
  run modes; the manifest `apps:` map; archive
  ignore rules; environment and secret mappings; stable URLs; cold wake and
  idle stop; lifecycle commands; rollback and retention; resource limits; and
  current boundaries. Load before deploying or operating an App.
</reference>

<reference path="references/kortix/marketplace.md">
  In-depth Kortix Marketplace reference. What the marketplace is, when to use
  it before authoring a new skill, CLI and web workflows, install/update/remove
  semantics, `registry-lock.json`, default starter skills, source registries,
  and the difference between consumer `kortix marketplace` commands and
  developer-only `kortix registry` commands.
</reference>

<reference path="references/authoring-skills.md">
  Full guide to authoring an Agent Skill to the agentskills.io spec: skill
  anatomy (`SKILL.md` + optional `scripts/`/`references/`/`assets/`), every
  frontmatter field and the `name`/`description` rules, the full authoring
  workflow, keeping `SKILL.md` lean via progressive disclosure, the two
  validation checks (spec validator + runtime discovery), how to land a
  skill via CR and package it for sharing, a worked example, and common
  frontmatter errors with fixes. Load whenever creating, editing,
  restructuring, or validating a skill.
</reference>

<reference path="references/kortix/tools.md">
  Tools on every harness: the three kinds (harness, Kortix, project), the
  seven Kortix tools every project has without an entry, the `tools:`
  registry (name → module; a Kortix tool's name replaces that tool),
  `kortix tools eject <name>`, one checklist per task (add a tool, hide a
  tool from an agent, change a Kortix tool), the harness-neutral module
  contract (`description`, JSON Schema `parameters`,
  `execute(args, context)` with `sessionId`, `agent`, `directory`, `env`,
  `signal`), the `kortix validate` errors, per-agent access with
  `agents.<name>.tools` (`all`, `none`, a list, `exclude`), output size,
  imports, when a change takes effect, and porting a tool out of a legacy
  harness folder. Load before writing, changing, removing or restricting a
  tool.
</reference>

<reference path="references/kortix/kortix-yaml.md">
  In-depth `kortix.yaml` reference for `kortix_version: 3`: the registries
  (`skills`, `tools`, `commands`, `extensions`), every agent key with its
  default and what it compiles to, the three permission layers, `imports:`
  and the split-by-topic layout with a feature folder, every shared
  top-level key (`project:`, `env:`, `sandbox:`), every `triggers:` field
  (cron + webhook, incl. `session_mode` and the project-wide
  `triggers_paused` kill-switch), the prompt template variables, the
  secrets contract, validation, common gotchas, and the legacy versions 1
  and 2 with `kortix migrate`. Load this when editing or debugging the
  manifest.
</reference>

<reference path="references/kortix/kortix-yaml-v2.md">
  The `kortix.yaml` reference for `kortix_version: 2`, the version new
  projects are created on: the governance-only `agents:` map with each
  agent's behavior in its `agents/<name>.md`, the harness folders
  (`harnesses/opencode/`, `harnesses/pi/`), and the `tools:` map. Load this
  before editing a v2 manifest.
</reference>

<reference path="references/scheduling.md">
  The triggers **operational playbook** — deciding which mechanism to use
  (one-off `run_at` vs recurring `cron` vs `webhook`), the full croner
  cheat-sheet and gotchas (DOM+DOW OR-not-AND trap, no exact-minute
  gates), fresh-vs-reuse `session_mode` decision guidance, notifying the
  user (Slack push, when to stay silent), idempotency/dedup patterns for
  recurring runs, the pause-and-wait re-fire pattern for mid-task waits,
  worked examples, and a pre-ship checklist. Companion to
  `kortix-yaml.md` (schema) and `kortix-cli.md` (commands). Load whenever
  the user wants something scheduled, recurring, reminded, or
  webhook-triggered.
</reference>

<reference path="references/kortix/change-requests.md">
  Full Kortix change-request reference. The data model (the
  `change_requests` table — `cr_id`, `number`, `head_ref`, `base_ref`,
  `status`, `head_commit_sha`, `base_commit_sha`, `origin_session_id`,
  `merge_commit_sha`), the lifecycle (`open` → `merged` | `closed`,
  reopen path), the CLI surface (`kortix cr ls / show / diff / open /
  merge / close / reopen`) with every flag, the REST API endpoints under
  `/v1/projects/:projectId/change-requests/...`, the merge-preview /
  conflict story, the agent mandate ("MUST open a CR for changes to
  land on `main`"), and common gotchas (force-pushes, merged-CR diffs,
  origin_session_id orphaning). Load this whenever the user mentions
  change requests, CRs, merging, landing work, opening a PR-equivalent,
  or asks how Kortix handles the GitHub-PR gap.
</reference>

<reference path="references/pi/overview.md">
  How pi fits into a Kortix project: how to tell which harness a session
  runs, what a pi session reads (the compiled `kortix.yaml` agents and the
  root `AGENTS.md`), the features pi does not support, and when a change
  takes effect. Load it first for any
  customization request in a pi session.
</reference>

<reference path="references/pi/tools.md">
  The tools of a pi session (`bash`, `read`, `write`, `edit`, `glob`,
  `grep`, `question`, `task`, the Kortix tools `web_search`,
  `image_search`, `scrape_webpage`, `memory`, `show`, and the project's own
  tools), their arguments, the OpenCode tools pi does not have
  and what to use instead, and the `permission` rules that govern each tool.
</reference>

<reference path="references/pi/agents.md">
  Agents on pi (the agent keys pi applies), subagents through the `task`
  tool (the agents in the agent's `subagents` grant), and how pi loads the
  agent's granted skills.
</reference>

<reference path="references/pi/extensions.md">
  pi extensions and pi packages, registered as `extensions.<name>.pi` in
  `kortix.yaml` and enabled per agent, with a worked extension and the test
  procedure. The pi
  counterpart of OpenCode plugins and custom tools.
</reference>

<reference path="references/opencode/overview.md">
  OpenCode sessions only. How OpenCode fits into a Kortix project — how
  `kortix.yaml` compiles to OpenCode's agents, permissions, commands and
  plugins — plus the index into the per-feature
  pages mirrored from opencode.ai/docs/.
</reference>

<reference path="references/opencode/agents.md">
  Agent personas. Primary vs subagent, frontmatter schema, permission
  keys. In a Kortix project, set them on the `kortix.yaml` agent block. Mirrored from
  <https://opencode.ai/docs/agents/>.
</reference>

<reference path="references/opencode/skills.md">
  On-demand `SKILL.md` definitions. Discovery paths, frontmatter rules,
  name validation, permission gating. Mirrored from
  <https://opencode.ai/docs/skills/>.
</reference>

<reference path="references/opencode/commands.md">
  Custom `/`-prefixed slash commands. Frontmatter, `$ARGUMENTS`,
  positional args, shell-output and file-reference placeholders.
  Mirrored from <https://opencode.ai/docs/commands/>.
</reference>

<reference path="references/opencode/tools.md">
  Built-in tools (bash, edit, write, read, grep, glob, lsp, apply_patch,
  skill, todowrite, webfetch, websearch, question) AND custom tools
  (`.opencode/tools/<file>.ts` via `@opencode-ai/plugin`'s `tool()`
  helper, polyglot via `Bun.$`). Mirrors
  <https://opencode.ai/docs/tools/> and
  <https://opencode.ai/docs/custom-tools/>.
</reference>

<reference path="references/opencode/plugins.md">
  Plugin hooks (`tool.execute.before`, `session.idle`, `shell.env`,
  `experimental.session.compacting`, etc.), npm vs local loading,
  TypeScript types, examples (notifications, .env protection, custom
  tools, compaction). Mirrored from <https://opencode.ai/docs/plugins/>.
</reference>

<reference path="references/opencode/mcp-servers.md">
  Local + remote MCP servers, OAuth handling, the `mcp` config key,
  glob-based tool gating, per-agent enablement, common examples
  (Sentry, Context7, Grep). Mirrored from
  <https://opencode.ai/docs/mcp-servers/>.
</reference>

<reference path="references/opencode/permissions.md">
  The `permission` config — global `*`, per-tool, pattern-based bash
  rules, `external_directory`, defaults (including `.env` deny),
  per-agent overrides, what "ask" actually does. Mirrored from
  <https://opencode.ai/docs/permissions/>.
</reference>

<reference path="references/opencode/rules.md">
  `AGENTS.md` — the project-wide instructions file OpenCode auto-loads.
  Project vs global, Claude Code (`CLAUDE.md`) compatibility, precedence
  rules, the `instructions` config key for referencing external files.
  Mirrored from <https://opencode.ai/docs/rules/>.
</reference>

<reference path="references/opencode/models.md">
  Model selection (`/models`), recommended models, default config,
  per-provider options, custom variants, model loading priority order.
  Mirrored from <https://opencode.ai/docs/models/>.
</reference>

</references>

<gotchas>
Things that surprise people:

- **The workspace IS global — sessions are not.** A Kortix project is
  one big GitHub repo everyone shares. Persistent changes happen by
  committing to the session branch and **opening a change request**
  that merges back to `main`. Every session — even thousands running
  concurrently — gets its own isolated sandbox + ephemeral branch.
  Branches can `git pull` from `main` to pick up the latest. Merging
  back to `main` is how anything becomes persistent, and the *only*
  sanctioned path is `kortix cr open` → user review → merge.
- **Merging to `main` is a CR — there is no other path.** Direct
  pushes to `main` from inside the sandbox skip the user-review
  contract and surprise the user. If an agent has changes worth
  keeping, the next move is *always* `kortix cr open`, never a force
  push, never asking the user to copy files out. See the
  `<change-requests>` section above.
- **Keep big static assets out of Git.** Every session builds its agent
  config from the whole repository at the base commit (history and `.git`
  do not count), and downloads every file. A new session takes the files
  from its own checkout, whatever the size. A running session picks up a
  base-branch change through the project snapshot, built up to 512 MiB
  compressed; above that it keeps the config it runs until a new session
  starts. Put videos, images, datasets, model weights and generated media
  in object storage (S3, R2, GCS) or a CDN, and download them at runtime.
  Add build output (`dist/`, `out/`, `node_modules/`) to `.gitignore`.
  `kortix validate` warns about any file of 10 MiB or more and a
  repository over 512 MiB; run it before you commit. A path that must stay in Git but that no agent reads can be
  left out of the agent config with `<path> export-ignore` in
  `.gitattributes`.
- **Triggers live in `kortix.yaml`, not as files.** Old Kortix shipped
  triggers under `.opencode/triggers/<slug>.md` — that's gone.
  Centralized in the manifest now, parsed as `triggers:`.
- **One manifest, no harness folders.** On `kortix_version: 3` every
  agent, skill, tool, command and extension is named in `kortix.yaml`. A
  file the manifest does not name does nothing: a `SKILL.md` that `skills:`
  does not register, a plugin that `extensions:` does not register, a
  command file in a legacy `harnesses/opencode/commands/` folder.
- **Everything is per agent.** A registered skill, command or extension
  reaches only the agents that enable it by name. An agent with no `skills`
  key loads no skill, not even a Kortix skill.
- **An extension can be one harness only.** An `extensions.<name>` entry
  with only `pi:` does nothing in an OpenCode session, and the reverse.
  Check the harness first (`<harnesses>` above). Write a tool that both
  harnesses need as a project tool (`kortix.yaml` `tools:`).
- **Provider verification is a real prompt.** A generic key check cannot prove
  a model, region, entitlement, and API dialect together. Test the exact
  model through a session prompt.
- **Manifest schema is versioned.** `kortix_version` lets the platform
  evolve safely. A manifest declaring a higher version than the platform
  knows about is rejected outright — better than silent misread.
- **`env.required` is advisory, not enforced.** The platform surfaces
  `required` to the dashboard so the user knows what to set, but session
  bootstrap won't block on missing values today. Treat `required` as a
  contract with the user, not the platform.
</gotchas>

</skill>

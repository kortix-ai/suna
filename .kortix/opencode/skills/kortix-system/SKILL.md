---
name: kortix-system
description: "Canonical reference for a Kortix project: the platform model (repo-native projects, sessions on ephemeral branches, the strict boundary between `kortix.toml` and OpenCode config under `.kortix/opencode/`); the full `kortix.toml` manifest (keys, trigger fields, secrets contract, `[[apps]]` deploy surface); the complete `kortix` CLI (commands, flags, the project-scoped token model, the in-sandbox `KORTIX_SANDBOX_TOKEN`); the change-request (CR) system for landing session work on `main` (an agent MUST open a CR to merge); the session sandbox runtime (which supports Docker and Docker-in-Docker); and the OpenCode runtime (agents, skills, commands, tools, plugins, MCP servers, permissions, AGENTS.md rules, models). Load whenever the user asks how Kortix works, about `kortix.toml`, the `kortix` CLI, anything under `.kortix/opencode/`, how to merge/ship/land work on `main`, change requests/CRs/PRs, or to author/edit any OpenCode primitive."
---

<skill name="kortix-system">

<overview>
A **Kortix project** is one GitHub repo with a `kortix.toml` at the root — a shared workspace anyone (and any number of agents) can work in. A **session** is one conversation = one ephemeral sandbox VM = one branch named after the session id. The sandbox dies when the session ends; the branch persists. Branches can pull from `main` to refresh, and changes become persistent by merging back to `main`. Sessions are isolated, but the underlying repo is the global workspace.

The repo has two configuration surfaces with strict ownership:

- **Kortix config** — `kortix.toml` at the repo root, plus the `.kortix/` folder beside it (Dockerfile, opencode dir). The platform reads this for project config, sandbox/triggers/apps, and Kortix-side agent governance.
- **OpenCode config** — `.kortix/opencode/` (`opencode.jsonc`, agents, skills, commands, tools, plugins). OpenCode reads this as its native runtime implementation. `opencode.jsonc` remains the OpenCode-native registry for plugins, MCP servers, providers, models, permissions, and default runtime behavior.

Kortix-specific things — triggers, env spec, sandbox image, deployable apps, project metadata, and which agents the platform may launch/authorize — go in `kortix.toml`. OpenCode-specific things — agent personas, on-demand skills, slash commands, custom tools, plugins, MCP servers, providers — stay under `.kortix/opencode/`. Each side owns its half.

The default agent runtime inside every session is **OpenCode**. For legacy projects, OpenCode-native discovery remains backward-compatible. For projects that adopt `[[agents]]`, Kortix treats the manifest as the server-side source for the launchable agent list and grants, while still launching OpenCode against its native config dir. The same `.kortix/opencode/` config dir can still drive a local `opencode` run on the user's machine.
</overview>

<project-as-workspace>
**A Kortix project is a standalone workspace — not an add-on to a code repo.**

The project's own repo is the agent's home/desk: it owns the agent's config
(personas, connectors, triggers, channels) and its brain (memory), and it *may*
hold persistent work artifacts the agent should truly keep (documents, PDFs,
spreadsheets, notes, generated sites). Keep it small — it is cloned into every
session.

Anything heavy or better-lived-elsewhere is **referenced, not owned**:

- **Code repos** are external work artifacts. When a task needs one, clone it
  **on demand** into the session (sparse/shallow as appropriate), do the work,
  and open a PR back to *that repo's* upstream. The repo is a workspace the agent
  *visits*, not a repository the project *is*.
- **Large data / SaaS systems** (Linear, GitHub, Betterstack, Stripe, a data
  warehouse) are reached via **connectors**, never copied in.

The heuristic is just common sense: *would auto-cloning this into every session be
sane?* Small and truly yours → keep it in the project. Large or external →
reference it. A small code repo *could* live inside a project; a giant monorepo
should not.

**Anti-patterns:** ❌ `kortix init` inside an existing product repo to "make the
product a Kortix project" — create a new, dedicated project instead. ❌ pulling a
large repo in as a submodule/subtree. ❌ copying large external data in "so the
agent has it" — reach it through a connector.

Tradeoff, chosen on purpose: the native CR flow (branch = session, CR = merge to
`main`) stays first-class for the project's **own** repo; changes to **external**
code repos go via the agent's git + GitHub connector as plain PRs.
</project-as-workspace>

<when-to-load>
Load this skill when the user asks any of:

- "What does `kortix.toml` do?" / "What is `kortix_version`?"
- "How do I add a cron trigger / webhook?" / "Why isn't my webhook firing?"
- "Where do secrets come from?" / "Why does my session fail to start?"
- "What's the difference between `kortix.toml` and `opencode.jsonc`?"
- "How do I customize the sandbox image?"
- "Can I run Docker / Docker-in-Docker in the sandbox?" /
  "Can I run containers / a database in a session?" /
  "Can I actually verify my work from inside the sandbox?"
- "How do I deploy a frontend from this project?" (`[[apps]]`)
- "How do I create a new OpenCode agent / skill / slash command / custom tool / plugin?"
- "How do I register an MCP server?"
- "How do I tighten permissions for the build agent?"
- "What does `AGENTS.md` do in OpenCode?"
- "Which model should I default to?" / "How do I configure reasoning effort?"
- "How do I land this work on `main`?" / "Open a PR / change request for me"
- "How do change requests work in Kortix?" / "What's `kortix cr`?"

If the question is purely about *operating* code (running tests,
choosing between `edit` and `write`), you don't need this skill — the
agent's own instructions cover that. This skill is the **configuration
+ platform** reference.
</when-to-load>

<cli>
You are running inside a Kortix session sandbox — a real Linux VM that
**DOES support Docker and Docker-in-Docker** (`dockerd`, `docker build`,
running containers/services all work). Never assume a sandbox can't run
Docker or that you "can't verify from here" — you can; see the `sandbox.md`
reference below. The **`kortix` CLI**
is on `$PATH` (`/usr/local/bin/kortix`) and pre-authenticated against
this exact project — a project-scoped token is already injected as
`$KORTIX_CLI_TOKEN`, with `$KORTIX_API_URL` pointed at the right host.
You can run `kortix …` from any shell with zero setup. (Don't reach for
`$KORTIX_SANDBOX_TOKEN` (the deprecated `$KORTIX_TOKEN` alias still works too):
that's the sandbox *service key* for the runtime/LLM/git
layer, and the project APIs reject it — just use the CLI, which already
holds the right token.)

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
| "restart / kill session `<id>`" | `kortix sessions restart <id>` / `kortix sessions rm <id>` |
| "fire the daily-digest trigger" | `kortix triggers fire daily-digest` |
| "show open change requests" | `kortix cr ls` |
| "who am I? what project is this?" | `kortix whoami`, `kortix projects info` |
| "deploy the marketing app" | `kortix apps deploy marketing-site` (when `[[apps]]` is enabled) |
| "add / list connectors" | `kortix connectors add <slug> --provider …`, `kortix connectors ls`, `connectors show <slug>` |
| **"add a connector NOW, no CR (like the UI)"** | agent: `add_connector` MCP tool / `kortix executor add <slug> --provider pipedream --app <app>` · human: `kortix connectors add … --apply` — commits to `kortix.toml` on main + syncs server-side, live this session |
| **"I need an API key the human has (e.g. `APOLLO_API_KEY`)"** | `request_secret` MCP tool / `kortix secrets request NAME` — mint a link, **surface it**. You never see the value. |
| **"I need this app connected (Pipedream)"** | `connect` MCP tool / `kortix executor connect <slug>` / `kortix connectors link <slug>` — mint a 1-click link, **surface it**. No "go to the dashboard". |
| "set a connector's credential directly" | `kortix connectors credential <slug>` *(admin/login only — prefer the link above)* |
| "who can use a connector" | `kortix connectors share <slug> --mode project\|private\|members` |
| "shared profile vs each-member-BYO" | `kortix connectors mode <slug> shared\|per_user` |
| "rename a connector" | `kortix connectors rename <slug> "Gmail (work)"` |
| "control what a connector may do (per-tool / glob / regex)" | `kortix connectors policy <slug> set <match> allow\|ask\|block` · `policy <slug> ls\|rm\|clear` |
| "project-wide execution rules" | `kortix connectors policy ls`, `policy set --default risk\|allow_all` |

> **Connectors are fully CLI-configurable** — everything the dashboard's Customize → Connectors does (add/remove, connect, credential, profile model, who-can-use, rename, and per-tool/glob/**regex** Allow/Ask/Block permissions) has a `kortix connectors …` command. `add`/`rm`/`policy set --default` edit the local `kortix.toml` (then `kortix ship`); the rest apply immediately via the cloud. Inside a session the agent **uses** connectors through the `kortix-executor` MCP (`connectors`/`discover`/`describe`/`call`), and the gateway enforces these policies on every call (returning a denial or pending-approval).

> **Getting a credential — never punt to the dashboard.** When you need an API key
> or an app connected, **mint a setup link and surface the URL in the same turn**
> — don't tell the human to "open Customize → Connectors". Use the `request_secret`
> / `connect` tools on the `kortix-executor` MCP (or `kortix secrets request` /
> `kortix executor connect` / `kortix connectors link`). The
> human gets a fill-in modal (web) or a tappable link (Slack); you never touch the
> raw value. This is the streamlined default — do it automatically whenever you
> add or need a tool. Full playbook in the
> **credentials-and-setup-links** reference below.

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

**Token scope reminder.** The CLI's token (`$KORTIX_CLI_TOKEN`) is
project-scoped — it cannot enumerate other projects or hit account-level
routes. Trying `kortix projects ls` from inside the sandbox returns 403;
that's intentional. Use `kortix projects info` to inspect **this** project.

**Full reference:** `.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md`
— every command, every flag, every env var, common workflows. Load it
when you need exact syntax.
</cli>

<change-requests>
**This is the single most important rule for any agent running in a
Kortix session: if you want your work to land on `main`, you MUST open
a change request (CR).**

Sessions run on ephemeral branches (`session-<id>`). The session VM
dies when the conversation ends; the branch persists in git, but
**nothing on it reaches `main` automatically.** A session-branch
commit is invisible to every future session — they all boot from
`main`. The only sanctioned merge path is a CR — the user reviews
the diff in the dashboard or CLI and merges it (or asks for changes,
or closes it).

### The mandate

When you, as an agent, have changes you believe should persist:

1. **Commit on the session branch.** Small, working commits. No
   force-pushes, no rewriting upstream history.
2. **Push the branch.**
   ```sh
   git push origin HEAD
   ```
3. **Open a CR.** From inside the sandbox the CLI reads
   `$KORTIX_BRANCH_NAME`, `$KORTIX_SESSION_ID`, and `$KORTIX_SANDBOX_TOKEN`
   (deprecated alias: `$KORTIX_TOKEN`) automatically:
   ```sh
   kortix cr open \
     --title  "Short, imperative summary" \
     --description "What changed and why. Test plan. Risks."
   ```
4. **Surface the CR to the user.** Print the CR number so they can
   review:
   ```sh
   kortix cr ls
   ```
5. **Wait.** The user merges via dashboard, CLI (`kortix cr merge
   <n>`), or asks for changes. *You do not merge your own CRs.*

### Don't bypass this

- **Don't push to `main` directly.** The platform doesn't currently
  block force-pushes to protected branches in every backend, but
  doing so violates the user-review contract and surprises the user.
- **Don't paper over with "I committed it on my branch."** That isn't
  persistence. The session branch dissolves; only `main` survives.
- **Don't ask the user to copy-paste files out of the session.** The
  CR exists precisely so they don't have to.

### How a CR composes with the rest of the system

| Surface       | How it interacts with the CR                                                              |
| ------------- | ----------------------------------------------------------------------------------------- |
| Sandbox       | CR is opened from inside the sandbox via `$KORTIX_SANDBOX_TOKEN` (deprecated alias: `$KORTIX_TOKEN`). Branch tip is the session HEAD. |
| Dashboard     | Renders the CR — title, description, diff, merge preview, conflict markers.               |
| CLI           | `kortix cr ls / show / diff / open / merge / close / reopen` — full life-cycle locally.   |
| `kortix.toml` | Edits to triggers / env / apps land via CR like any other file.                           |
| Skills        | New `.kortix/opencode/skills/<name>/SKILL.md` files reach future sessions **only** after a CR merges. |
| Triggers      | Cron / webhook trigger edits reach the scheduler **only** after the CR merges to `main`.  |

Full reference: `.kortix/opencode/skills/kortix-system/references/kortix/change-requests.md`.
</change-requests>

<contract>
The boundary between the two halves of the project:

| Surface           | Owner    | File                                                       | Read by                          |
| ----------------- | -------- | ---------------------------------------------------------- | -------------------------------- |
| Kortix config     | Kortix   | `kortix.toml` + `.kortix/Dockerfile`                       | The Kortix platform              |
| OpenCode config   | OpenCode | `.kortix/opencode/opencode.jsonc` + everything beside it   | OpenCode (local + sandbox); Kortix may inspect metadata for server-side agent/model UI surfaces |

The location of OpenCode's config dir is declared in `kortix.toml` under `[opencode] config_dir` — the default is `.kortix/opencode`. Relocate only if you want to share one OpenCode config across multiple Kortix repos.

Do not duplicate OpenCode-native config in `kortix.toml`. `opencode.jsonc` owns plugins, MCP, providers, model/provider config, and OpenCode runtime defaults. `kortix.toml` owns the project/platform manifest and, when adopted, the server-side registry of launchable agents and their Kortix grants. Dashboard edits to triggers / env / apps are read-modify-writes on `kortix.toml` — they round-trip cleanly with edits made inside a session.
</contract>

<agent-authorization>
## Per-agent governance — `[[agents]]`

An agent **is** its OpenCode `.md` (front matter + system prompt). Everything about
*how an agent behaves* stays OpenCode-native in that file. `kortix.toml`'s optional
`[[agents]]` block is the Kortix-side declaration for **launchability and authority**,
keyed by the agent's name. Today it primarily adds the two things OpenCode's agent
config cannot express:

```toml
[[agents]]
name       = "release-bot"            # = the agent's .md name (e.g. .kortix/opencode/agents/release-bot.md)
connectors = ["github"]               # which connector profiles it may call   (default: none)
kortix_cli = ["project.deploy", "project.cr.open"]   # what it may do via the Kortix CLI/API (default: none)
```

**Which file owns what — never duplicate across the boundary:**

| Setting | Lives in |
| --- | --- |
| system prompt, `model`, `mode`, `tools`, **`permission`** (incl. `permission.skill` to scope **skills**) | the agent's **`.md`** / `opencode.jsonc` (OpenCode-native) |
| plugins, MCP servers, providers, runtime model catalog/defaults | **`opencode.jsonc`** (OpenCode-native) |
| **`connectors`** (integration access) + **`kortix_cli`** (Kortix CLI/API powers) | **`kortix.toml` `[[agents]]`** |

**How the grant resolves at session start (v1, backward-compatible):**
- Manifest has **no `[[agents]]`** at all → legacy mode: no agent-grant restriction, and older UI/runtime paths may discover agents directly from OpenCode. Existing projects are unchanged.
- Agent **is listed** → its `connectors` + `kortix_cli` (default each = none if omitted).
- Manifest **has `[[agents]]` but this agent isn't listed** → default-**deny** for Kortix grants (it can still be a native OpenCode file, but Kortix should not expose it as a platform-launchable agent unless it is listed).
- **Your default agent:** with no `[[agents]]` it has **full access** (merge / deploy / spawn sub-agents, ∩ the user). The moment you adopt `[[agents]]`, **declare it too** — `[[agents]] name = "kortix"`, `kortix_cli = "all"`, `connectors = "all"` — or it falls under the unlisted-deny rule above. So: keep the default agent `"all"` and scope the *specialists* down.
- The effective grant is always **∩ the launching user's role** — an agent can never exceed the human who launched it. Editing `kortix.toml` only takes effect once the **CR is merged** (read from the default branch).

**Discovery contract:**
- `[[agents]]` is an opt-in to declarative, server-side agent discovery. It is not a validation rule that every file under `.kortix/opencode/agents/` must be registered. Unregistered native files can exist for local experiments or runtime internals.
- Once a project adopts declarative agents, Kortix chat inputs, trigger/channel pickers, and other product UI should fetch agents from the server-side Kortix registry, not directly from the sandbox OpenCode `/app/agents` result.
- Model lists should follow the same direction: UI fetches the server/LLM-gateway model catalog, not a sandbox-local OpenCode provider list, so connected-provider policy and billing stay server-owned.
- Future manifest versions / new project templates may default to declarative discovery. Older projects stay in legacy OpenCode-discovery mode until they opt in or are migrated.

**`kortix_cli` — the grantable enum** (project-scoped only; account-level admin actions
like `member.*` / `billing.*` / `project.create` can NEVER be granted to an agent). Run
`kortix validate --scopes` to print this list:

```
project.read  project.write  project.delete  project.deploy
project.cr.open  project.cr.merge          # opening a CR ≠ merging it (merge lands code on main)
project.session.read  project.session.start  project.session.exec  project.session.stop
project.members.read  project.members.manage
project.trigger.read  project.trigger.create  project.trigger.update  project.trigger.delete  project.trigger.fire
channel.read  channel.connect  channel.send  channel.disconnect
```

`kortix validate` validates `[[agents]]` (rejecting unknown / account-scoped actions) and
prints each agent's resolved scope. Use `kortix validate --scopes` to see the full enum.
</agent-authorization>

<references>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/credentials-and-setup-links.md">
  How to get a credential you don't have — an API key, or an app connected —
  by minting a short-lived **setup link** and surfacing the URL, instead of
  punting the human to the dashboard or asking them to paste a raw key. Covers
  the two link kinds (secret intake / Pipedream Quick Connect), how to mint each
  (the `request_secret` + `connect` MCP tools, or the `kortix secrets request` /
  `kortix executor connect` / `kortix connectors link` CLI), what the human sees
  (web modal vs Slack link), how to verify it
  landed, the runtime-vs-connector scope choice, and the security model. Load
  this whenever you hit "I need an API key / I need this app connected" — it is
  the canonical, autonomous flow.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/sandbox.md">
  The session sandbox runtime environment — what you can run inside a
  session. Key point: the sandbox **fully supports Docker and
  Docker-in-Docker** — `dockerd`, building images, and running
  containers/services all work. The #1 misconception to kill: an agent
  assuming a sandbox can't run Docker/containers and therefore that it
  "can't verify from here." It can. Load this whenever an agent is about
  to run the stack, reaches for Docker/containers, or starts to doubt it
  can verify from inside the sandbox.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md">
  In-depth `kortix` CLI reference. Every subcommand (login, hosts,
  projects, secrets, env, sessions, triggers, cr, init, update,
  uninstall), every flag, every env var the CLI reads. Includes the
  project-scoped token model and what the CLI can do **from inside a
  session sandbox** (where `KORTIX_SANDBOX_TOKEN` + `KORTIX_API_URL` are
  pre-injected so `kortix sessions ls`, `kortix secrets set FOO=bar`,
  `kortix cr ls` all work out of the box). Load this when you want to
  drive the Kortix cloud from a terminal or agent.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/kortix-toml.md">
  In-depth `kortix.toml` reference. Every top-level table (`[project]`,
  `[env]`, `[sandbox]`, `[opencode]`), every `[[triggers]]` field (cron +
  webhook), the prompt template variables, the secrets contract, the
  `[[apps]]` deployment surface, schema versioning, common gotchas.
  Load this when editing or debugging the manifest.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/change-requests.md">
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

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/overview.md">
  How OpenCode fits into a Kortix project — where each primitive lives
  under `.kortix/opencode/`, how the same dir drives both the remote
  sandbox and local `opencode` runs — plus the index into the per-feature
  pages mirrored from opencode.ai/docs/.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/agents.md">
  Agent personas. Primary vs subagent, frontmatter schema, permission
  keys, configuration in `opencode.jsonc` or markdown. Mirrored from
  <https://opencode.ai/docs/agents/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/skills.md">
  On-demand `SKILL.md` definitions. Discovery paths, frontmatter rules,
  name validation, permission gating. Mirrored from
  <https://opencode.ai/docs/skills/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/commands.md">
  Custom `/`-prefixed slash commands. Frontmatter, `$ARGUMENTS`,
  positional args, shell-output and file-reference placeholders.
  Mirrored from <https://opencode.ai/docs/commands/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/tools.md">
  Built-in tools (bash, edit, write, read, grep, glob, lsp, apply_patch,
  skill, todowrite, webfetch, websearch, question) AND custom tools
  (`.opencode/tools/<file>.ts` via `@opencode-ai/plugin`'s `tool()`
  helper, polyglot via `Bun.$`). Mirrors
  <https://opencode.ai/docs/tools/> and
  <https://opencode.ai/docs/custom-tools/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/plugins.md">
  Plugin hooks (`tool.execute.before`, `session.idle`, `shell.env`,
  `experimental.session.compacting`, etc.), npm vs local loading,
  TypeScript types, examples (notifications, .env protection, custom
  tools, compaction). Mirrored from <https://opencode.ai/docs/plugins/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/mcp-servers.md">
  Local + remote MCP servers, OAuth handling, the `mcp` config key,
  glob-based tool gating, per-agent enablement, common examples
  (Sentry, Context7, Grep). Mirrored from
  <https://opencode.ai/docs/mcp-servers/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/permissions.md">
  The `permission` config — global `*`, per-tool, pattern-based bash
  rules, `external_directory`, defaults (including `.env` deny),
  per-agent overrides, what "ask" actually does. Mirrored from
  <https://opencode.ai/docs/permissions/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/rules.md">
  `AGENTS.md` — the project-wide instructions file OpenCode auto-loads.
  Project vs global, Claude Code (`CLAUDE.md`) compatibility, precedence
  rules, the `instructions` config key for referencing external files.
  Mirrored from <https://opencode.ai/docs/rules/>.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/opencode/models.md">
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
- **Triggers live in `kortix.toml`, not as files.** Old Kortix shipped
  triggers under `.opencode/triggers/<slug>.md` — that's gone.
  Centralized in the manifest now, parsed as `[[triggers]]`.
- **Kortix-owned files live in `.kortix/` at the repo root.** The
  `Dockerfile` and `opencode/` config dir sit under there to keep the
  root clean. Both paths are declared in `kortix.toml`
  (`[sandbox] dockerfile`, `[opencode] config_dir`) — relocate freely.
- **OpenCode primitives remain runtime-native.** Adding a skill, command,
  tool, plugin, MCP, or provider is still an OpenCode config change. Declaring
  an agent in `[[agents]]` is a separate Kortix decision: it controls what the
  platform may launch and what server-side grants that agent receives.
- **Manifest schema is versioned.** `kortix_version` lets the platform
  evolve safely. A manifest declaring a higher version than the platform
  knows about is rejected outright — better than silent misread.
- **`[env].required` is advisory, not enforced.** The platform surfaces
  `required` to the dashboard so the user knows what to set, but session
  bootstrap won't block on missing values today. Treat `required` as a
  contract with the user, not the platform.
- **`[[apps]]` is experimental.** Gated behind
  `KORTIX_APPS_EXPERIMENTAL`. When off, entries are parsed but never
  acted on.
</gotchas>

</skill>

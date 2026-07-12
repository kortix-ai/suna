---
name: kortix-system
description: "Canonical reference for a Kortix project: the platform model (repo-native projects, sessions on ephemeral branches, the strict boundary between `kortix.yaml` and OpenCode config under `.kortix/opencode/`); the full `kortix.yaml` manifest (keys, trigger fields, secrets contract, `apps:` deploy surface); the complete `kortix` CLI (commands, flags, the project-scoped token model, the in-sandbox `KORTIX_SANDBOX_TOKEN`); the change-request (CR) system for landing session work on `main` (an agent MUST open a CR to merge); the session sandbox runtime (which supports Docker and Docker-in-Docker); and the OpenCode runtime (agents, skills, commands, tools, plugins, MCP servers, permissions, AGENTS.md rules, models). Load whenever the user asks how Kortix works, about `kortix.yaml`, the `kortix` CLI, anything under `.kortix/opencode/`, how to merge/ship/land work on `main`, change requests/CRs/PRs, or to author/edit any OpenCode primitive."
---

<skill name="kortix-system">

<live-skills>
The `kortix` CLI is the live source of truth for how Kortix works. The Kortix
**system skills** — `kortix-system`, `kortix-executor`, `kortix-memory`,
`kortix-slack`, `kortix-computer`, `kortix-meet` — are served fresh by the CLI,
so their instructions always match the platform version you're running on (no
re-install, no image re-bake):

- `kortix skills` — list the Kortix system skills.
- `kortix skills get <name>` — print one skill's current SKILL.md body.
- `kortix skills get <name> --full` — also include its referenced files.
- `kortix skills --all` — list every Kortix skill (not just the system floor).

Before answering anything about Kortix internals — the executor/connectors,
project memory, Slack/channels, reaching a connected computer, or sending a
notetaker into a meeting — load the matching skill with `kortix skills get
<name>` and follow it. Prefer this over any stale local copy; the CLI reflects
the platform you're actually on.
</live-skills>

<overview>
A **Kortix project** is one GitHub repo with a `kortix.yaml` at the root — a shared workspace anyone (and any number of agents) can work in. A **session** is one conversation = one ephemeral sandbox VM = one branch named after the session id. The sandbox dies when the session ends; the branch persists. Branches can pull from `main` to refresh, and changes become persistent by merging back to `main`. Sessions are isolated, but the underlying repo is the global workspace.

The repo has two configuration surfaces with strict ownership:

- **Kortix config** — `kortix.yaml` at the repo root, plus the `.kortix/` folder beside it (Dockerfile, opencode dir). The platform reads this for project config, sandbox/triggers/apps, and Kortix-side agent governance.
- **OpenCode config** — `.kortix/opencode/` (`opencode.jsonc`, agents, skills, commands, tools, plugins). OpenCode reads this as its native runtime implementation. `opencode.jsonc` remains the OpenCode-native registry for plugins, MCP servers, providers, models, permissions, and default runtime behavior.

Kortix-specific things — triggers, env spec, sandbox image, deployable apps, project metadata, and which agents the platform may launch/authorize — go in `kortix.yaml`. OpenCode-specific things — agent personas, on-demand skills, slash commands, custom tools, plugins, MCP servers, providers — stay under `.kortix/opencode/`. Each side owns its half.

The default agent runtime inside every session is **OpenCode**. For legacy v1 projects (which used `kortix.toml`), OpenCode-native discovery remains backward-compatible. For projects on `agents:` (v2, `kortix.yaml`) — or the legacy `[[agents]]` (v1 TOML) — Kortix treats the manifest as the server-side source for the launchable agent list and grants, while still launching OpenCode against its native config dir. The same `.kortix/opencode/` config dir can still drive a local `opencode` run on the user's machine.
</overview>

<when-to-load>
Load this skill when the user asks any of:

- "What does `kortix.yaml` do?" / "What is `kortix_version`?"
- "How do I add a cron trigger / webhook?" / "Why isn't my webhook firing?"
- "Where do secrets come from?" / "Why does my session fail to start?"
- "What's the difference between `kortix.yaml` and `opencode.jsonc`?"
- "How do I customize the sandbox image?"
- "How do I deploy a frontend from this project?" (`apps:`)
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
You are running inside a Kortix session sandbox. The **`kortix` CLI**
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
| "deploy the marketing app" | `kortix apps deploy marketing-site` (when `apps:` is enabled) |

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

**Getting a credential — never punt to the dashboard.** When you need an API key
or an app connected, **mint a setup link and surface the URL in the same turn** —
don't tell the human to "open Customize → Connectors", and don't ask them to
paste a raw key into chat. Use the `request_secret` / `connect` tools on the
`kortix-executor` MCP (or `kortix secrets request` / `kortix executor connect` /
`kortix connectors link`). The human gets a fill-in
modal (web) or a tappable link (Slack); you never touch the raw value. Do this
automatically whenever you add or need a tool. Full playbook in the
**credentials-and-setup-links** reference below.

**Exception — connecting Slack itself.** Slack is a built-in channel, not a
connector or a secret. `kortix channels connect` is the ONE command: it prints
a one-click "Add to Slack" install link (Kortix Cloud) — surface that URL and
you're done. No manifest, no bot token, no secret-intake link. Details in the
`kortix-slack` skill.

**Full reference:** `.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md`
— every command, every flag, every env var, common workflows. Load it
when you need exact syntax.
</cli>

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
`.kortix/opencode/skills/...`, updates `registry-lock.json`, and commits the
change to the project repo. Installed state and update detection come from the
lock file's target paths and content hashes, not from a hidden database flag.
`update --all` uses one server-side batch update so all outdated skills land in
one commit.

**Full reference:** `.kortix/opencode/skills/kortix-system/references/kortix/marketplace.md`
— load it whenever you need to pick skills, explain installed/update status,
debug marketplace behavior, or decide whether to create a new skill.
</marketplace>

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
   rewrite history that isn't yours.
3. **Push the branch.** This step is NOT optional — a commit that
   never leaves the sandbox produces an empty, un-appliable CR:
   ```sh
   git push origin HEAD
   ```
   If the push is rejected because the remote session branch moved
   (the platform can advance it to the latest base), run
   `git fetch origin` then `git push --force-with-lease origin HEAD`.
   Force-pushing is acceptable ONLY for your own session branch —
   never for `main` or anyone else's branch.
4. **Open a CR.** From inside the sandbox the CLI reads
   `$KORTIX_BRANCH_NAME`, `$KORTIX_SESSION_ID`, and `$KORTIX_SANDBOX_TOKEN`
   (deprecated alias: `$KORTIX_TOKEN`) automatically:
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
| `kortix.yaml` | Edits to triggers / env / apps land via CR like any other file.                           |
| Skills        | New `.kortix/opencode/skills/<name>/SKILL.md` files reach future sessions **only** after a CR merges. |
| Triggers      | Cron / webhook trigger edits reach the scheduler **only** after the CR merges to `main`.  |

Full reference: `.kortix/opencode/skills/kortix-system/references/kortix/change-requests.md`.
</change-requests>

<contract>
The boundary between the two halves of the project:

| Surface           | Owner    | File                                                       | Read by                          |
| ----------------- | -------- | ---------------------------------------------------------- | -------------------------------- |
| Kortix config     | Kortix   | `kortix.yaml` + `.kortix/Dockerfile`                       | The Kortix platform              |
| OpenCode config   | OpenCode | `.kortix/opencode/opencode.jsonc` + everything beside it   | OpenCode (local + sandbox); Kortix may inspect metadata for server-side agent/model UI surfaces |

The location of OpenCode's config dir is declared in `kortix.yaml` under `opencode: config_dir` — the default is `.kortix/opencode`. Relocate only if you want to share one OpenCode config across multiple Kortix repos.

Do not duplicate OpenCode-native config in `kortix.yaml`. `opencode.jsonc` owns plugins, MCP, providers, model/provider config, and OpenCode runtime defaults. `kortix.yaml` owns the project/platform manifest and the server-side registry of launchable agents and their Kortix grants. Dashboard edits to triggers / env / apps are read-modify-writes on `kortix.yaml` — they round-trip cleanly with edits made inside a session.
</contract>

<canonical-schema>
## The canonical manifest schema — one URL, always correct

This project's `kortix.yaml` is `kortix_version: 2` — check its own top
`# yaml-language-server: $schema=...` line. That URL is the public, versioned
JSON Schema, generated straight from `@kortix/manifest-schema` (the same
package that backs `kortix validate` and the CR-merge gate — one source of
truth, no separate spec to keep in sync by hand):

| URL | Covers |
| --- | --- |
| `https://kortix.com/schema/kortix.v2.schema.json` | `kortix_version: 2` only (this project) |
| `https://kortix.com/schema/kortix.v1.schema.json` | `kortix_version: 1` only (legacy `[[agents]]` array + `[[channels]]`) |
| `https://kortix.com/schema/kortix.schema.json` | Both — dispatches on `kortix_version` |

`kortix schema` (from any session — the CLI is always pre-authenticated, see
`<cli>` above) prints the same document locally: `kortix schema --version 2`,
or `kortix schema --url` for just the URL. If you are AUTHORING or EDITING
`kortix.yaml` and unsure whether a field/shape is legal, this schema — not
this skill's prose, which can drift — is the authoritative structural spec;
`kortix validate` is the authoritative behavioral one (it also catches
cross-field rules the static schema can't express, e.g. `default_agent` must
name a declared agent).

**v2 in one paragraph** (see `<agent-authorization>` below for the fuller
write-up, and `docs/specs/2026-07-05-agent-first-config-unification.md` for
the design rationale): `agents:` is a name→block MAP (not the v1 `[[agents]]` array),
and every block is **governance only** —
`enabled`/`connectors`/`secrets`/`skills`/`kortix_cli`/`workspace`. `env` was
renamed `secrets`. There is no `model`/`mode`/`description`/`permission`/
`prompt` on the manifest side at all in v2 — every one of those is OpenCode
behavior and lives in that agent's own `.kortix/opencode/agents/<name>.md`
frontmatter, joined by name (this project's `kortix` and `memory-reflector`
agents both work this way — open their `.md` files to see what they
actually do). `default_agent` is required and must resolve to a declared,
enabled agent. `[[channels]]` is removed outright (channel↔agent routing is
dashboard-managed, not git). v2 is YAML-only and deny-by-default on every
grant set (an omitted `connectors`/`secrets`/`skills`/`kortix_cli` resolves
to `none`, not `all`).
</canonical-schema>

<agent-authorization>
## Per-agent governance — `agents:` (v2) / `[[agents]]` (v1, legacy)

An agent **is** its OpenCode `.md` (front matter + system prompt). Everything about
*how an agent behaves* stays OpenCode-native in that file. The manifest's optional
`agents:` map (v2 — `kortix.yaml`, this project's format) is the Kortix-side
declaration for **launchability and authority**, keyed by the agent's name — and in
v2 it is **governance only**: no `model`/`mode`/`description`/`permission`/`prompt`
on the manifest side at all (this project's `kortix` and `memory-reflector` agents
both work this way — open their `.md` files to see what they actually do).

```yaml
agents:
  release-bot:                          # = the agent's .md name (.kortix/opencode/agents/release-bot.md)
    connectors: [github]                # which connector profiles it may call   (default: none)
    kortix_cli: [project.deploy, project.cr.open]   # what it may do via the Kortix CLI/API (default: none)
```

**Which file owns what — never duplicate across the boundary:**

| Setting | Lives in |
| --- | --- |
| system prompt, `model`, `mode`, `tools`, **`permission`** (incl. `permission.skill` to scope **skills**) | the agent's **`.md`** / `opencode.jsonc` (OpenCode-native) |
| plugins, MCP servers, providers, runtime model catalog/defaults | **`opencode.jsonc`** (OpenCode-native) |
| **`connectors`** (integration access) + **`secrets`** (env-var access) + **`kortix_cli`** (Kortix CLI/API powers) + **`skills`** | the manifest's **`agents:`** map (v2) / **`[[agents]]`** array (v1) |

**How the grant resolves at session start:**
- v2 (`kortix.yaml`) is **deny-by-default**: an omitted `connectors`/`secrets`/`skills`/`kortix_cli` on a declared agent resolves to `none`, not `all`. `default_agent` is required and must resolve to a declared, enabled agent — give it `connectors: all`, `secrets: all`, `kortix_cli: all`, `skills: all` explicitly if it should keep full access.
- v1 (`kortix.toml`, legacy) is **backward-compatible** instead: manifest has **no `[[agents]]`** at all → no agent-grant restriction, agents discovered straight from OpenCode. Agent **is listed** → its `connectors`/`kortix_cli` (default each = none if omitted). Manifest **has `[[agents]]` but this agent isn't listed** → default-deny for Kortix grants. The v1 default agent keeps **full access** only while `[[agents]]` is unadopted — the moment you add `[[agents]]`, declare the default agent too or it falls under the unlisted-deny rule.
- The effective grant is always **∩ the launching user's role** — an agent can never exceed the human who launched it. Editing the manifest only takes effect once the **CR is merged** (read from the default branch).

**Discovery contract:**
- Declaring `agents:` (v2) or `[[agents]]` (v1) is an opt-in to declarative, server-side agent discovery. It is not a validation rule that every file under `.kortix/opencode/agents/` must be registered. Unregistered native files can exist for local experiments or runtime internals.
- Once a project adopts declarative agents, Kortix chat inputs, trigger/channel pickers, and other product UI should fetch agents from the server-side Kortix registry, not directly from the sandbox OpenCode `/app/agents` result.
- Model lists should follow the same direction: UI fetches the server/LLM-gateway model catalog, not a sandbox-local OpenCode provider list, so connected-provider policy and billing stay server-owned.
- New projects default to `kortix.yaml` (v2) declarative discovery. Older `kortix.toml` (v1) projects stay in legacy mode until they migrate.

**`kortix_cli` — the grantable enum** (project-scoped only; account-level admin actions
like `member.*` / `billing.*` / `project.create` can NEVER be granted to an agent — nor can
`project.delete` / `project.members.manage` / `project.gateway.keys.manage`: the project-role
collapse promoted those three to ACCOUNT owner/admin authority even though they still target a
specific project). Run `kortix validate --scopes` to print this list:

```
project.read  project.write  project.deploy
project.cr.open  project.cr.merge          # opening a CR ≠ merging it (merge lands code on main)
project.session.read  project.session.start  project.session.stop
project.members.read
project.trigger.read  project.trigger.create  project.trigger.update  project.trigger.delete  project.trigger.fire
project.gateway.logs.read  project.gateway.spend.read  project.gateway.budget.set
project.agent.read  project.agent.write
project.skill.read  project.skill.write
project.command.read  project.command.write
project.file.read  project.file.write
project.customize.read  project.customize.write
project.gitops.read  project.gitops.push  project.gitops.merge
project.secret.read  project.secret.write
project.connector.read  project.connector.write   # channels (Slack/meet/email) send + connect are gated here
project.review.read  project.review.submit  project.review.act
```

`kortix validate` validates `agents:` (v2) / `[[agents]]` (v1) — rejecting unknown /
account-scoped actions — and prints each agent's resolved scope. Use `kortix validate --scopes`
to see the full enum.
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
  landed, and the security model. Load this whenever you hit "I need an API key /
  I need this app connected" — it is the canonical, autonomous flow.
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

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/marketplace.md">
  In-depth Kortix Marketplace reference. What the marketplace is, when to use
  it before authoring a new skill, CLI and web workflows, install/update/remove
  semantics, `registry-lock.json`, default starter skills, source registries,
  and the difference between consumer `kortix marketplace` commands and
  developer-only `kortix registry` commands.
</reference>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/kortix-yaml.md">
  In-depth `kortix.yaml` reference. Every top-level key (`project:`,
  `env:`, `sandbox:`, `opencode:`), every `triggers:` field (cron +
  webhook), the prompt template variables, the secrets contract, the
  `apps:` deployment surface, schema versioning, common gotchas, and a
  legacy note on the v1 `kortix.toml` TOML format. Load this when
  editing or debugging the manifest.
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
- **Triggers live in `kortix.yaml`, not as files.** Old Kortix shipped
  triggers under `.opencode/triggers/<slug>.md` — that's gone.
  Centralized in the manifest now, parsed as `triggers:`.
- **Kortix-owned files live in `.kortix/` at the repo root.** The
  `Dockerfile` and `opencode/` config dir sit under there to keep the
  root clean. Both paths are declared in `kortix.yaml`
  (`sandbox: dockerfile`, `opencode: config_dir`) — relocate freely.
- **OpenCode primitives remain runtime-native.** Adding a skill, command,
  tool, plugin, MCP, or provider is still an OpenCode config change. Declaring
  an agent in `agents:` is a separate Kortix decision: it controls what the
  platform may launch and what server-side grants that agent receives.
- **Manifest schema is versioned.** `kortix_version` lets the platform
  evolve safely. A manifest declaring a higher version than the platform
  knows about is rejected outright — better than silent misread.
- **`env.required` is advisory, not enforced.** The platform surfaces
  `required` to the dashboard so the user knows what to set, but session
  bootstrap won't block on missing values today. Treat `required` as a
  contract with the user, not the platform.
- **`apps:` is experimental.** Gated behind
  `KORTIX_APPS_EXPERIMENTAL`. When off, entries are parsed but never
  acted on.
</gotchas>

</skill>

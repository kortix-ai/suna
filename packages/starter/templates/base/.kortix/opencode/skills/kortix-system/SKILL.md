---
name: kortix-system
description: Canonical reference for a Kortix project. Covers (1) the platform overview — repo-native projects, sessions backed by ephemeral branches, the strict boundary between Kortix config (`kortix.toml`) and OpenCode config (`.kortix/opencode/`) — (2) the in-depth `kortix.toml` manifest with every key, every trigger field, the secrets contract, the `[[apps]]` deployment surface, (3) the full `kortix` CLI reference (every command, every flag, the project-scoped token model, what works inside a session sandbox with the pre-injected `KORTIX_TOKEN`), and (4) the OpenCode runtime reference mirroring opencode.ai/docs/ for agents, skills, commands, tools (built-in + custom), plugins, MCP servers, permissions, rules (AGENTS.md), and models. Load when the user asks how Kortix works, asks about anything in `kortix.toml` or the `kortix` CLI, asks about anything under `.kortix/opencode/`, or needs to author/edit any OpenCode primitive (agent persona, skill, slash command, custom tool, plugin, MCP server, permission policy, AGENTS.md rule, or model config).
---

<skill name="kortix-system">

<overview>
A **Kortix project** is one GitHub repo with a `kortix.toml` at the root — a shared workspace anyone (and any number of agents) can work in. A **session** is one conversation = one ephemeral sandbox VM = one branch named after the session id. The sandbox dies when the session ends; the branch persists. Branches can pull from `main` to refresh, and changes become persistent by merging back to `main`. Sessions are isolated, but the underlying repo is the global workspace.

The repo has two configuration surfaces with strict ownership:

- **Kortix config** — `kortix.toml` at the repo root, plus the `.kortix/` folder beside it (Dockerfile, opencode dir). The platform reads this.
- **OpenCode config** — `.kortix/opencode/` (`opencode.jsonc`, agents, skills, commands, tools, plugins). OpenCode reads this; the platform never touches it.

Kortix-specific things — triggers, env spec, sandbox image, deployable apps, project metadata — go in `kortix.toml`. OpenCode-specific things — agent personas, on-demand skills, slash commands, custom tools, plugins, MCP servers, providers — stay under `.kortix/opencode/`. Each side owns its half.

The default agent runtime inside every session is **OpenCode**. The same `.kortix/opencode/` config dir drives both the remote sandbox and a local `opencode` run on the user's machine — one source of truth, both surfaces.
</overview>

<when-to-load>
Load this skill when the user asks any of:

- "What does `kortix.toml` do?" / "What is `kortix_version`?"
- "How do I add a cron trigger / webhook?" / "Why isn't my webhook firing?"
- "Where do secrets come from?" / "Why does my session fail to start?"
- "What's the difference between `kortix.toml` and `opencode.jsonc`?"
- "How do I customize the sandbox image?"
- "How do I deploy a frontend from this project?" (`[[apps]]`)
- "How do I create a new OpenCode agent / skill / slash command / custom tool / plugin?"
- "How do I register an MCP server?"
- "How do I tighten permissions for the build agent?"
- "What does `AGENTS.md` do in OpenCode?"
- "Which model should I default to?" / "How do I configure reasoning effort?"

If the question is purely about *operating* code (running tests, opening a PR, choosing between `edit` and `write`), you don't need this skill — the agent's own instructions cover that. This skill is the **configuration** reference.
</when-to-load>

<cli>
You are running inside a Kortix session sandbox. The **`kortix` CLI**
is on `$PATH` and pre-authenticated against this exact project — a
project-scoped token is already injected as `$KORTIX_TOKEN` (also
`$KORTIX_CLI_TOKEN`) with `$KORTIX_API_URL` pointed at the right host.
You can run `kortix …` from any shell with zero setup.

**Reach for the CLI** whenever the user asks for something that touches
Kortix cloud state — not just files in the repo. Examples:

| The user says… | Use… |
| --- | --- |
| "list / read project secrets" | `kortix secrets ls` |
| "set / unset a secret" | `kortix secrets set NAME=VALUE`, `kortix secrets unset NAME` |
| "pull / push my `.env`" | `kortix env pull`, `kortix env push --from .env` |
| "what sessions are running right now?" | `kortix sessions ls` |
| "spawn another session to do X" | `kortix sessions new --prompt "X"` |
| "restart / kill session `<id>`" | `kortix sessions restart <id>` / `kortix sessions rm <id>` |
| "fire the daily-digest trigger" | `kortix triggers fire daily-digest` |
| "show open change requests" | `kortix cr ls` |
| "who am I? what project is this?" | `kortix whoami`, `kortix projects info` |
| "deploy the marketing app" | `kortix apps deploy marketing-site` (when `[[apps]]` is enabled) |

**Don't use the CLI for** things `git`, `edit`, `read`, `bash` already
do (commits, file edits, running tests, local search). The CLI is the
cloud-state surface; everything else is local.

**Token scope reminder.** `$KORTIX_TOKEN` is project-scoped — it
cannot enumerate other projects or hit account-level routes. Trying
`kortix projects ls` from inside the sandbox returns 403; that's
intentional. Use `kortix projects info` to inspect **this** project.

**Full reference:** `.kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md`
— every command, every flag, every env var, common workflows. Load it
when you need exact syntax.
</cli>

<contract>
The boundary between the two halves of the project:

| Surface           | Owner    | File                                                       | Read by                          |
| ----------------- | -------- | ---------------------------------------------------------- | -------------------------------- |
| Kortix config     | Kortix   | `kortix.toml` + `.kortix/Dockerfile`                       | The Kortix platform              |
| OpenCode config   | OpenCode | `.kortix/opencode/opencode.jsonc` + everything beside it   | OpenCode (local + sandbox)       |

The location of OpenCode's config dir is declared in `kortix.toml` under `[opencode] config_dir` — the default is `.kortix/opencode`. Relocate only if you want to share one OpenCode config across multiple Kortix repos.

The platform never reads opencode's config dir; OpenCode never reads `kortix.toml`. Dashboard edits to triggers / env / apps are read-modify-writes on `kortix.toml` — they round-trip cleanly with edits made inside a session.
</contract>

<references>

<reference path=".kortix/opencode/skills/kortix-system/references/kortix/kortix-cli.md">
  In-depth `kortix` CLI reference. Every subcommand (login, hosts,
  projects, secrets, env, sessions, triggers, cr, init, update,
  uninstall), every flag, every env var the CLI reads. Includes the
  project-scoped token model and what the CLI can do **from inside a
  session sandbox** (where `KORTIX_TOKEN` + `KORTIX_API_URL` are
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
  committing to the session branch and merging back to `main`. Every
  session — even thousands running concurrently — gets its own isolated
  sandbox + ephemeral branch. Branches can `git pull` from `main` to
  pick up the latest config; merging back to `main` is how anything
  becomes persistent. (PR-creation isn't GitHub-native yet; today
  branches land on the repo and the user PR/merges externally.)
- **Triggers live in `kortix.toml`, not as files.** Old Kortix shipped
  triggers under `.opencode/triggers/<slug>.md` — that's gone.
  Centralized in the manifest now, parsed as `[[triggers]]`.
- **Kortix-owned files live in `.kortix/` at the repo root.** The
  `Dockerfile` and `opencode/` config dir sit under there to keep the
  root clean. Both paths are declared in `kortix.toml`
  (`[sandbox] dockerfile`, `[opencode] config_dir`) — relocate freely.
- **OpenCode primitives are never platform-special.** The platform
  doesn't read them; OpenCode does. Adding a new agent/skill/command/
  tool/plugin is purely an OpenCode config change.
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

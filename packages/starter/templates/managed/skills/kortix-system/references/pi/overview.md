# pi in a Kortix project

pi is one of the two harnesses a Kortix session can run. The other is
OpenCode. A harness is the agent runtime inside the session sandbox: it runs
the model loop, calls the tools and writes the transcript. A session runs
exactly one harness.

pi runs inside the sandbox daemon process. It has no server of its own, no
port and no child process. The clients (web, CLI, TUI, mobile, SDK) read a pi
session through the same Kortix routes as an OpenCode session.

## Which harness this session runs

Run this in the session shell:

```bash
echo "${KORTIX_HARNESS:-opencode}"
```

`pi` means pi. `opencode`, or an unset variable, means OpenCode.

Kortix selects the harness when a session starts, restarts or resumes:

| Rule, in order | Harness |
| --- | --- |
| The project's `llm_gateway` flag is off | OpenCode |
| The project's `pi_harness` flag is on | pi |
| `kortix.yaml` sets `runtime: pi` | pi |
| Anything else | OpenCode |

A running session keeps its harness until it restarts. pi calls models only
through the Kortix LLM gateway.

## What pi reads from the repository

A `kortix_version: 3` session reads only the compiled manifest. Kortix
compiles `kortix.yaml` (and every file it imports) and gives pi the agents,
their grants, the registered skills, commands and extensions.

| Source | What pi does with it |
| --- | --- |
| `agents.<name>` in `kortix.yaml` | The agent: prompt (`prompt` or `prompt_file`), behavior and grants. See `agents.md`. |
| `skills:` registry | The project skills, each one a folder with `SKILL.md`. An agent sees the ones its `skills` grant names. |
| `commands:` registry | Slash commands. An agent runs the ones its `commands` grant names. |
| `extensions:` registry | pi packages and extension files (`extensions.<name>.pi`). An agent loads the ones its `extensions` grant names. See `extensions.md`. |
| `agents.<name>.codemode` | `on` (default), `only` or `off`: pi's `codemode` tool. |
| `memory/` | The project brain, through the `memory` tool. |
| `AGENTS.md` | The project-wide rules, at the repository root. pi puts the file in the system prompt of the session and of each subagent. A root with no `AGENTS.md` gives `CLAUDE.md` instead. pi reads no `AGENTS.md` in a subdirectory. |

pi reads no harness folder: not `harnesses/`, `.kortix/`, `.pi/` or
`.opencode/`, and no `settings.json` or `opencode.jsonc` from the project.
Legacy: a `kortix_version` 1 or 2 project still uses `harnesses/pi/` (or
`pi.config_dir`, or `.kortix/pi/`) for `extensions/`, `prompts/`, `skills/`
and `settings.json`. `kortix migrate` prints the v3 manifest;
`kortix migrate --write` writes it.

## Commands

A command is a registered prompt that an agent enables:

```yaml
commands:
  review:
    description: Review the current change.
    prompt: Review $ARGUMENTS and list each problem with its file and line.
agents:
  reviewer:
    commands: [review]
```

`$ARGUMENTS` takes all arguments. `$1`, `$2`, … take one word each; the last
one takes the rest. Running a command on an agent that does not enable it
answers `403` with `command_not_enabled`.

## Compaction

pi summarizes the older part of a long conversation by itself: when the
context nears the model's window, and when a model request overflows it (pi
then retries that request once). `kortix sessions compact <id>` and the
dashboard's "Compact" do it on demand. The transcript keeps every message;
only the model's context gets shorter.

## What pi does not support

pi answers a request for a feature it does not have with
`501 feature_not_supported`. It does not ignore the request.

| Feature | On pi |
| --- | --- |
| Rewind to a message, edit-and-resend | Not supported. |
| MCP servers | No MCP client. Use connectors through `kortix connectors`, or a pi package. |
| Todo list (`todowrite`) | No tool. |
| `opencode attach` | Not supported. |

Do not tell a user to "restart opencode", to edit `opencode.jsonc`, or to add
an OpenCode plugin when the session runs pi. None of that changes a pi
session.

## When a change takes effect

- A change on the session branch reaches future sessions only after its
  change request merges into the default branch.
- pi loads extensions when the runtime starts. A running session does not
  load a new or changed one, and `kortix sessions restart` does not reload
  them. A session that starts after
  the change request merges loads them.
- A skill is visible only when the compiled manifest registers it and the
  agent's `skills` grant names it. A skill added on the session branch is
  available after its change request merges.
- Kortix builds the npm packages of `extensions` when the change request
  merges. A session started before the merge does not have them.
- A running session picks up a merged agent, skill, `AGENTS.md` or manifest
  change without a new session: it runs the base branch's config release. It
  reads `AGENTS.md` from that release, never from `/workspace`: an edit in
  `/workspace/AGENTS.md` changes nothing until it merges.
- `harness.details.agentsMd` in `GET /kortix/health` names the `AGENTS.md` pi
  loaded: `source`, `path`, `bytes` and `sha`.

## Reference pages

| Page | Contents |
| --- | --- |
| `tools.md` | The tools a pi session has, their arguments, and the permission keys that govern them. |
| `agents.md` | Agents, subagents and skills on pi. |
| `extensions.md` | pi extensions and pi packages. |

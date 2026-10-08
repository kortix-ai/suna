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

| Path | What pi does with it |
| --- | --- |
| `kortix.yaml` | Kortix compiles the agents and their grants and gives them to pi. `runtime`, `harnesses.pi.packages` and `pi.config_dir` are the pi keys (`../kortix/kortix-yaml.md`). |
| `agents/<name>.md` | The agent's prompt and behavior. See `agents.md`. |
| `skills/<name>/SKILL.md` | Project skills. See `agents.md` → Skills. |
| `memory/` | The project brain, through the `memory` tool. |
| `AGENTS.md` | The project-wide rules, at the repository root. pi puts the file in the system prompt of the session and of each subagent. A root with no `AGENTS.md` gives `CLAUDE.md` instead. pi reads no `AGENTS.md` in a subdirectory. |
| `harnesses/pi/` | pi's own config directory. See below. |

pi does NOT read these. They belong to OpenCode:

- `harnesses/opencode/opencode.jsonc`, `plugins/`, `tools/`, `commands/`;
- `~/.config/opencode/` and `.opencode/`.

## The pi config directory

pi reads one directory for the files only pi uses. The first match wins:

1. `pi.config_dir` in `kortix.yaml` (a repository-relative path);
2. `harnesses/pi/`;
3. `.kortix/pi/` (legacy).

The starter project does not create this directory. Create `harnesses/pi/`
when the project needs one of these:

| Path in the directory | Contents |
| --- | --- |
| `extensions/*.ts` | pi extensions: tools, hooks and commands. See `extensions.md`. |
| `prompts/*.md` | pi prompt templates. Each one is a slash command: the composer lists it, and a prompt that starts with `/<name>` expands the template. `$1`, `$2` and `$ARGUMENTS` take the arguments. |
| `skills/<name>/SKILL.md` | Skills only pi sessions load. Prefer the root `skills/`, which both harnesses load. |
| `settings.json` | pi settings. `compaction` (`enabled`, `reserveTokens`, `keepRecentTokens`) applies. Kortix turns off pi's own retry, whatever the file says. Only `./` entries of `packages` load from this file; declare npm packages in `kortix.yaml`. |

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
| OpenCode command files (`harnesses/opencode/commands/*.md`) | Not read. Put the command in `harnesses/pi/prompts/` as a prompt template. |
| MCP servers | No MCP client. Use connectors through `kortix connectors`, or a pi package. |
| Todo list (`todowrite`) | No tool. |
| `opencode attach` | Not supported. |

Do not tell a user to "restart opencode", to edit `opencode.jsonc`, or to add
an OpenCode plugin when the session runs pi. None of that changes a pi
session.

## When a change takes effect

- A change on the session branch reaches future sessions only after its
  change request merges into the default branch.
- pi loads extensions, prompt templates and `settings.json` when the runtime
  starts. A running session does not load a new or changed one, and
  `kortix sessions restart` does not reload them. A session that starts after
  the change request merges loads them.
- pi reads skills again when the session restarts. A skill added on the
  session branch is available in that session after
  `kortix sessions restart <id>`.
- Kortix builds the npm packages in `harnesses.pi.packages` when the change
  request merges. A session started before the merge does not have them.
- With the project's `config_releases` flag on, a running session picks up a
  merged agent, skill, `AGENTS.md` or pi config change without a new session.
  It reads `AGENTS.md` from that release, never from `/workspace`: an edit in
  `/workspace/AGENTS.md` changes nothing until it merges.
- With the flag off, pi reads `/workspace/AGENTS.md` when the session starts or
  restarts and after `kortix sessions reload <id>`, not before each turn.
- `harness.details.agentsMd` in `GET /kortix/health` names the `AGENTS.md` pi
  loaded: `source`, `path`, `bytes` and `sha`.

## Reference pages

| Page | Contents |
| --- | --- |
| `tools.md` | The tools a pi session has, their arguments, and the permission keys that govern them. |
| `agents.md` | Agent files, subagents and skills on pi. |
| `extensions.md` | pi extensions and pi packages. |

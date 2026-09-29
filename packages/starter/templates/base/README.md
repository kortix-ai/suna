# {{projectName}}

This project runs OpenCode through its REST API.

## Layout

| Path | What it holds |
| --- | --- |
| `kortix.yaml` | Agents and what each may access, triggers, env. |
| `agents/<name>.md` | One file per agent: frontmatter + prompt. `kortix.yaml` names it as `agents.<name>.file`. |
| `skills/<name>/SKILL.md` | Skills. Every agent harness loads them. |
| `memory/` | The project brain. Load the `kortix-memory` skill to work with it. |
| `harnesses/opencode/` | Files only OpenCode reads: `opencode.jsonc`, `plugins/`, `tools/`. |

## Authentication

OpenCode can use Kortix-managed models or project provider credentials.

## Verify the project

## Test the runtime

1. Create a session.
2. Send a real prompt.
3. Confirm that the response completes.

A provider availability check does not prove prompt execution. Test the model
that the project will use.

Run `kortix system-skills get kortix-system --full` for the current platform
instructions. Run `kortix schema --version 2` for the exact manifest schema.

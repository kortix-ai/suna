# {{projectName}}

A Kortix project. `kortix.yaml` (kortix_version 3) defines every agent: the
project registers what exists, and each agent enables what it uses. A session
runs the pi agent harness.

## Layout

| Path | What it holds |
| --- | --- |
| `kortix.yaml` | The registry (`skills`, `tools`, `commands`, `extensions`), the agents, triggers and secret names. |
| `agents/<name>.md` | An agent's prompt. `agents.<name>.prompt_file` names it. Behavior (mode, model, permission) is in `kortix.yaml`. |
| `skills/<name>/SKILL.md` | Skills. `skills.<name>` registers each folder. The Kortix skills (`kortix-*`) are always registered. |
| `tools/<name>.ts` | Project tools. `tools.<name>` registers each module. The Kortix tools (`web_search`, `image_search`, `scrape_webpage`, `memory`, `show`) are always registered. `kortix tools eject <name>` copies one here for you to change. `kortix tools ls` lists what a session gets. |
| `extensions/<name>/` | pi extensions. `extensions.<name>.pi` names a pi package: an exact npm pin or a repo path. |
| `memory/` | The project brain. Load the `kortix-memory` skill to work with it. |

## Agents

| Agent | Mode | What it does |
| --- | --- | --- |
| `kortix` | primary | The general knowledge worker. Every grant is `all`. |
| `harness-reflector` | primary | Refines the harness from recent sessions on a daily cron (the `harness-reflector` trigger, off by default). No connectors, no secrets. |
| `session-reviewer` | subagent | Reviews one session for the reflector. |

Grants are deny-by-default: an agent gets a skill, subagent, command,
extension, connector or secret only when its block enables it. A permission
that is not set is `allow`.

## Change the project

1. Edit `kortix.yaml` or an agent's prompt.
2. Run `kortix validate`. It checks the schema and that every registered
   file exists.
3. Run `kortix schema --version 3` for the full schema.

A project on kortix_version 1 or 2 upgrades with `kortix migrate` (preview)
and `kortix migrate --write`, or with `kortix projects upgrade`, which opens
the upgrade as a change request.

## Test the runtime

1. Create a session.
2. Send a real prompt.
3. Confirm that the response completes.

A provider availability check does not prove prompt execution. Test the model
that the project will use. Run `kortix system-skills get kortix-system --full`
for the current platform instructions.

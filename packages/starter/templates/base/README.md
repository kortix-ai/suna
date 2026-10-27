# {{projectName}}

A Kortix project. Talk to **My Kortix** in the Kortix app: it runs the agents
below for you, with your permissions.

| Path | What it holds |
| --- | --- |
| `kortix.yaml` | The project: its agents and what each may use, triggers, sandbox. |
| `agents/<name>.md` | One agent's instructions. `kortix.yaml` points at it with `prompt_file`. |
| `skills/<name>/SKILL.md` | Skills an agent loads when a task matches. |
| `memory/` | The project's memory. Agents read and add to it. |

Add an agent, a skill or a trigger by asking My Kortix, in **Customize**, or by
editing `kortix.yaml`. Check the file with `kortix validate`. The full reference
is at https://kortix.com/docs/project/manifest.

# {{projectName}}

A Kortix project. Talk to **My Kortix** in the Kortix app. It routes each task
to the right agent of this project and runs it with your permissions.

This project starts with one agent, **Worker** (`agents.worker` in
`kortix.yaml`, prompt in `agents/worker.md`). It does general-purpose work:
coding, research, writing, ops and data work. Add specialist agents next to
it; My Kortix routes each task to the agent that fits.

| Path | What it holds |
| --- | --- |
| `kortix.yaml` | The project: its agents and what each may use, triggers, sandbox. |
| `agents/<name>.md` | One agent's instructions. `kortix.yaml` points at it with `prompt_file`. |
| `skills/<name>/SKILL.md` | Skills an agent loads when a task matches. |
| `memory/` | The project's memory. Agents read and add to it. |

Add an agent, a skill or a trigger by asking My Kortix, in **Customize** and **Project admin**, or by
editing `kortix.yaml`. Check the file with `kortix validate`. The full reference
is at https://kortix.com/docs/project/manifest.

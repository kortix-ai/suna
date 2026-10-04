# {{projectName}}

A session of this project runs one agent harness: OpenCode (the default) or pi
(`runtime: pi` in `kortix.yaml`). Both read the same agents, skills and memory.

## Layout

| Path | What it holds |
| --- | --- |
| `kortix.yaml` | Agents and what each may access, triggers, env. |
| `agents/<name>.md` | One file per agent: frontmatter + prompt. `kortix.yaml` names it as `agents.<name>.file`. |
| `skills/<name>/SKILL.md` | Skills. Every agent harness loads them. |
| `memory/` | The project brain. Load the `kortix-memory` skill to work with it. |
| `harnesses/opencode/` | Files only OpenCode reads: `opencode.jsonc`, `plugins/`, `tools/`. |
| `harnesses/pi/` | Files only pi reads: `extensions/`, `prompts/`, `settings.json`. Not created by default. |

## Authentication

OpenCode can use Kortix-managed models or project provider credentials. pi uses
Kortix-managed models through the LLM gateway.

## Verify the project

## Test the runtime

1. Create a session.
2. Send a real prompt.
3. Confirm that the response completes.

A provider availability check does not prove prompt execution. Test the model
that the project will use.

Run `kortix system-skills get kortix-system --full` for the current platform
instructions. Run `kortix schema --version 2` for the exact manifest schema.

### Per-agent OpenCode plugins

Keep plugin implementations in `harnesses/opencode/plugins/`. A v2 manifest may select filename references per agent:

```yaml
harnesses:
  opencode:
    plugins: [audit.ts] # enabled for every agent
agents:
  specialist:
    harnesses:
      opencode:
        exclude: [audit.ts]
        plugins: [specialist.ts]
```

The selected agent gets its own config release. Unselected plugin entrypoints do not load, including their import-time hooks and sub-agent registrations. Imported modules under `plugins/` remain available. When no OpenCode plugin selection is declared, existing auto-discovery remains unchanged. Pi uses `harnesses.pi.packages` and agent-level `exclude` instead.

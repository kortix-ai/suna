# Project Memory

The **project brain** for the Kortix monorepo — the index to what this
project knows about itself. Memory is **not** auto-injected: at the start
of a task, `view` `.kortix/memory` with the **`memory` tool** to read this
index, then `view` the sub-files it points at when they're relevant. Skip
that step and you work blind to what the project already knows.

- [overview.md](overview.md) — what this project is, its purpose and shape
- [integrations.md](integrations.md) — third parties, MCP servers, channels, executor connectors
- [conventions.md](conventions.md) — patterns, naming, style, do / don't
- [decisions.md](decisions.md) — architectural and business choices worth not re-debating

Curated by the **memory-reflector** agent
(`.kortix/opencode/agents/memory-reflector.md`), which runs on the
`memory-reflector` cron trigger in `kortix.toml`. To add or update
memory, load the **kortix-memory** skill.

# Codex project instructions

Codex reads `AGENTS.md` automatically at the start of every session in this
repo — this is Codex's own convention, not a Kortix-invented file. Kortix
does not write to it or interpret its contents.

Behavior (instructions, sandboxing, approvals, MCP servers) lives entirely
in this `.codex/` directory, per Codex's own conventions. Kortix only routes
sessions here; it never configures what happens once one starts.

No `config.toml` is seeded here — nothing in the sandbox launch path expects
one by default; add it yourself if your project needs Codex-specific config.

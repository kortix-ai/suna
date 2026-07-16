# Claude Code project instructions

Claude Code reads this file automatically at the start of every session in
this repo. It is this harness's native project-instructions file — Kortix
does not write to it or interpret its contents.

Behavior (prompts, permissions, subagents, hooks, settings) lives entirely
in this `.claude/` directory, per Claude Code's own conventions. Kortix only
routes sessions here; it never configures what happens once one starts.

See the `kortix-system` skill (or your platform's harness docs) for how this
directory fits into the project's `kortix.yaml`.

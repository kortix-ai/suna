---
recorded: 2026-09-29T01:58:53Z
incident_date: 2026-09-29
---
# Check a merged generated index by its lines, never byte for byte

**Rule:** A committed, generated file that parallel branches each edit (the learnings `MEMORY.md`) is checked for the lines it holds, not their order. A GitHub squash merge keeps each branch's line where the branch put it, and nobody can regenerate the file between the merge and the push to `main`.

**Trigger surface:** Adding a generated index or catalog with a `--check` gate, or adding a learnings entry on a branch that merges after newer entries.

**Incident:** 2026-09-29. PR #8041 branched before four newer entries merged; its squash merge left its index line below them. `index.sh --check` compared byte for byte, and `flow-runner-unit` failed the core lane on every `main` push from 9700992a6f to 0fb2e8b5ce (4 runs).

**Enforcement:** `tests/unit/learnings-ledger.test.ts` "accepts an index reordered by a squash merge and rejects one that lost a line".

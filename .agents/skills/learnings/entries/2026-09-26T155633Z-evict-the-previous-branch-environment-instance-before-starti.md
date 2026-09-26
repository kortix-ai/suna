---
recorded: 2026-09-26T15:56:33Z
incident_date: 2026-09-16
---
# Evict the previous branch-environment instance before starting a preview stack

**Rule:** A branch environment outlives its PR number. The preview bootstrap
must stop every foreign `kortix-pr-*` compose project, remove stale instance
directories, and drop a foreign `last-good.env` before it starts its own stack.

**Trigger surface:** Closing and reopening a pull request under a new number
(revert-and-reopen), or any deploy to a persistent branch sandbox. The instance
is named `pr-<number>`, but the sandbox is keyed by branch and reused, and every
instance binds the same host ports.

**Incident:** 2026-09-15/16, PR #7236 (connector-flow, reopened after the
#7074 revert). The old instance's stack kept the ports, so every preview deploy
failed on `Bind for 127.0.0.1:15432 failed: port is already allocated` until a
label toggle destroyed the sandbox.

**Enforcement:** `tests/src/core/sandbox-preview.ts` evicts foreign instances
before starting its stack. The bootstrap runs from the default branch
(`deploy-preview.yml`), so the fix is live only once merged to `main`.

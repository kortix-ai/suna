---
recorded: 2026-09-28T04:18:46Z
incident_date: 2026-09-28
---
# Admit a preview suite only when the shared pool and managed-git credential have room; stop idle preview hosts

**Rule:** A preview suite consumes two shared budgets: Platinum org RAM (8 to 33
session boxes of 4 GB) and one managed-git credential (~145 new GitHub
repositories). Start it only when both have room, and stop what it created
when it ends. Stop, never delete, preview hosts that idle or whose pull request
closed. A reused host's log and result directory hold earlier runs: stream and
report only what this run wrote.

**Trigger surface:** `deploy-preview.yml`, `tests/src/core/sandbox-preview*.ts`,
`tests/src/core/preview-session-reaper.ts`, or anything that starts suites in
bulk (the software factory).

**Incident:** 2026-09-27/28. Five suites started within 15 min. 26 always-on
16 GB hosts held 416 of 512 GB. GitHub blocked the shared credential for 20 to
40 min after ~150 repository creations in an hour. Up to 56 flows per run timed
out in setup, across unrelated PRs. A deploy log replayed the previous suite's
`ke2e run` id and results. Fix: PR "preview-infra-green".

**Enforcement:** `tests/unit/preview-session-teardown.test.ts` (admission, host
stop, repo counter), `tests/unit/preview-session-reaper.test.ts`,
`tests/unit/sandbox-preview.test.ts` (results emptied under the lock).
None yet for the credential: give previews their own GitHub identity.

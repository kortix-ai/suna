---
recorded: 2026-10-03T18:30:13Z
incident_date: 2026-10-03
---
# Give every PR its own generated file, never one shared path every PR commits

**Rule:** A generated file that every PR commits must live at a per-PR path
(`tests/attestations/<branch>.json`), never at one shared path. Clean up other
PRs' files only by deleting them: a merged PR's file is never edited again, so
two branches that delete the same file merge clean.

**Trigger surface:** adding any file that `pnpm test`, a codegen step, or a
hook writes and a PR commits; editing `tests/verify-attestation.mjs`, the
`.githooks/pre-push` attestation check, or the company merge gate's
attestation lookup.

**Incident:** 2026-10-03. `pnpm test` wrote one shared
`tests/test-attestation.json` and every factory PR committed it. Each merge to
`main` made every other open PR conflict on that file (`git merge-tree`: 6 of 6
sampled conflicting PRs conflicted on it, 2 of them on nothing else). GitHub
marked them CONFLICTING, the merge gate skipped them, and each needed a worker
rebase and a new ~10-minute test run, so the gate merged about 1 PR per cycle.
Fixed by writing one attestation file per branch and pruning the others on
write (PR to suna `main`, "one attestation file per PR").

**Enforcement:** `tests/unit/attestation-diff.test.ts` "one attestation file per
PR": two PRs off one `main` stay mergeable (`git merge-tree --write-tree` exits
0) after one merges; two branches that pruned the same file merge clean; an
unrelated `main` merge keeps `verify --rev` green. Runs in the `core` lane.

---
recorded: 2026-10-03T11:33:42Z
incident_date: 2026-10-03
---
# Key the test attestation to the PR's own diff, not the whole tree

**Rule:** A local-test attestation must be keyed to the files the change itself
touched (`git diff origin/main...HEAD`), never to a hash of every tracked file.
A whole-tree hash goes stale on any unrelated edit — including merging
`origin/main` to resolve a conflict — so `pnpm test:verify` demands a fresh
~10-minute `pnpm test` for work the run never affected. Verify stays green while
the PR's own changed files are unchanged, and red only on a real overlap (a file
the PR changed is edited after the run) or a bad lane. Fall back to the full-tree
hash only on a direct main push, where there is no diverging merge-base.

**Trigger surface:** editing `tests/verify-attestation.mjs`, the
`tests/test-attestation.json` schema, the `.githooks/pre-push` attestation check,
or the company `test-attestation-gate` (`pnpm test:verify --rev <head>`); any
freshness key computed over a whole tree instead of a diff.

**Incident:** 2026-10-03. With the attestation keyed to `source_hash` (sha256 of
all tracked files), the autonomous merge gate thrashed: every PR that merged
`origin/main` to clear a conflict invalidated its attestation, and on a
fast-moving `main` with many concurrent factory PRs, Docker-less workers could
not regenerate attestations faster than `main` moved. Result: 0 merges in a 6h
window while ~125 PRs piled up. Fixed by keying the attestation to `diff_files` +
`diff_hash` over `git diff origin/main...HEAD` (PR to suna `main`).

**Enforcement:** `tests/unit/attestation-diff.test.ts` — a git-integration test
that attests a branch, merges an unrelated `origin/main` change, and asserts
`pnpm test:verify` still exits 0, plus a real-overlap edit exits non-zero and the
lane gates hold. Runs in the `core` lane (`pnpm --dir tests test:unit`).

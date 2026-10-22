---
recorded: 2026-10-08T19:36:36Z
incident_date: 2026-10-08
---
# Before merging a PR into dev, run pnpm test:verify on its head; a diff with no tests/attestations/ file never ran pnpm test

**Rule:** Before `gh pr merge` into `dev`, run `pnpm test:verify --rev <head> --branch <headRefName>` and merge only on exit `0`. A PR whose file list has no `tests/attestations/` entry never ran `pnpm test` on its final diff. Ask its author for the run, or run it yourself. Never merge it as is. Pull the PR files with `gh pr view <n> --json files`.

**Trigger surface:** Merging any PR into `dev`, from the CLI or the GitHub UI. This matters most for a PR that changes behavior and edits no test: its old tests still assert the old behavior.

**Incident:** 2026-10-08, PR #9380 (long pastes become a "Pasted text" tile).
- **What went wrong:** the PR changed 82 files, none of them under `tests/attestations/`, so its push skipped the pre-push hook. It merged at 15:27Z.
- **Cause:** 3 behavior changes were deliberate (`text/plain` uploads keep their type, a typed `&lt;pasted_content` tag is restored in titles, and the user-message copy button is named "Copy"). 5 tests still asserted the old behavior.
- **Blast radius:** `pnpm test` on `dev` failed `packages` and `db-suites` for ~3 h, until #9422 (18:19Z). Every branch that merged `dev` in that window could not attest. The pre-push hook refused each push until the branch fixed the same 5 tests, and two sessions fixed them in parallel (#9422, and #9423, which was closed as a duplicate).

**Enforcement:** none yet. `.githooks/pre-push` is the only gate (`verify-attestation.mjs`), and `--no-verify` or a checkout without the hooks skips it. No job runs on a PR into `dev`, by policy. The enforcer to build is a cheap guard on the push to `dev`, next to `secret-scan`. It would run `node tests/verify-attestation.mjs verify` for the merged PR's head, without running tests. On a missing, stale or red attestation it would comment on the merged PR and name its author, so the fix starts in minutes instead of at the next daily `Tests` run.

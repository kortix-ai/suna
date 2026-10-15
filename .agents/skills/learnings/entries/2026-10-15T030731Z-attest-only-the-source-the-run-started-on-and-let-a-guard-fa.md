---
recorded: 2026-10-15T03:07:31Z
incident_date: 2026-10-15
---
# Attest only the source the run started on, and let a guard fail closed only on a real match

**Rule:** A gate certifies exactly the input it checked. `pnpm test` fingerprints the
working tree before its lanes start and refuses to write the attestation when the
tree differs at the end. A guard that blocks on "found" must never read its own
crash as "found".

**Trigger surface:** Committing or editing files while `pnpm test` runs in the same
worktree. Writing or changing a commit/push guard (`scripts/check-*.sh`) that
pipes repository content through `awk`, `sed`, `grep` or a parser.

**Incident:** 2026-10-15, branch `enterprise-plans` (PR #9930), near-misses only.
1. `pnpm test` hashed the tree when it ENDED. A migration change committed mid-run
   was attested `db-suites: pass` without any DB suite having run against it. The
   next run reused that lane (`REUSE db-suites: already pass for this diff`). Caught
   by reading the reuse line; the full rerun found 14 suites that had never run on
   the new migration.
2. Dev's Capture merge added a test fixture with an invalid UTF-8 byte sequence.
   `scripts/check-blocked-terms.sh` ran `awk` in a UTF-8 locale; awk aborted on the
   line, and the guard treated the non-zero exit as a blocked term. Every merge of
   current dev into any branch was refused with "contains a blocked term".

**Enforcement:**
- `tests/verify-attestation.mjs fingerprint` + `KORTIX_ATTEST_FINGERPRINT` in
  `tests/src/core/local-runner.ts`; `tests/unit/attestation-diff.test.ts` "a write
  certifies only the source the run started on" goes red when the check is removed.
- `scripts/check-blocked-terms.sh` scans with `LC_ALL=C` (terms are ASCII);
  `scripts/check-blocked-terms.test.mjs` "an invalid UTF-8 line in a UTF-8 locale"
  goes red without it. Shipped in PR #9930.

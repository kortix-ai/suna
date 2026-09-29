---
recorded: 2026-09-26T15:55:26Z
incident_date: 2026-09-15
---
# `require_last_push_approval` on `prod` rejects a release approval when a human wrote the release PR's last commit

**Rule:** never push a hand-made commit (notes, VERSION, anything) directly to
an open `release/vX.Y.Z` PR. `prod` carries `require_last_push_approval: true`
plus `dismiss_stale_reviews: true`, so a commit authored by the approver
invalidates their own approval and the PR stays `BLOCKED` with no obvious
reason in the UI. Re-run `promote.yml` with the corrected `title`/`notes` so
`github-actions[bot]` force-pushes the head instead, then approve. Verify the
re-pushed `RELEASE_NOTES.md` is byte-identical to the intended text and
`RELEASE_SOURCE_SHA` is unchanged before approving.

**Trigger surface:** editing a release PR's notes, VERSION file, or any other
content by hand instead of through `promote.yml`.

**Incident:** v0.13.18 (2026-09-15): head `0d6a223442` (human-authored) was
`BLOCKED`; re-promoted to `342addf824` (`github-actions[bot]`), approval then
accepted.

**Enforcement:** none. A pre-push guard or a `promote.yml` comment naming this
failure mode is the TODO.

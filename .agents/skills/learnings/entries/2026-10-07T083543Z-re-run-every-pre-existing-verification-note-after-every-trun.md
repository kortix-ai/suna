---
recorded: 2026-10-07T08:35:43Z
incident_date: 2026-10-07
---
# Re-run every Pre-existing verification note after every trunk merge; a Pre-existing claim carried across a merge without a re-run is a false Verified claim

**Rule:** A `Pre-existing:` note in a PR body is a claim about a specific
revision, and it expires the moment the PR merges the trunk. After every merge
from the trunk into a PR branch, re-run every command the body cites as
pre-existing (and every "fails the same at <base>" claim) at the new head and
the new base; update or delete the note to match what the re-run actually
printed. Never copy a Verified/Pre-existing line forward across a merge.

**Trigger surface:** Any PR rework that merges the trunk (conflict routing,
branch currency) while the PR body carries a `Pre-existing:` or
"fails the same at base" verification claim. Here
`pnpm --filter kortix-api lint` cited in the PR body of the KRTX-696
follow-up.

**Incident:** 2026-10-07, PR #9228 (KRTX-696 follow-up). The body claimed the
lint command failed identically at origin/main
(`apps/api/src/git-proxy/project-snapshot-shared.ts:13`, projects-surface
import rule from #9140). The claim was written against pre-merge origin/main
and then carried through the main merge (a980f47) without a re-run; main's
#9140 (KRTX-1598, break the project-snapshot barrel import cycles) reworked
exactly that file, and the violation no longer existed at the merged base
`ad21f2e7c9` or at the head. The independent reviewer's (G9) re-run caught the
false claim: exit 0 at both revisions, three times. Blast radius: one wrong
line in a PR body — but a Verified line a reviewer's own run contradicts is
enough for a request_changes and a full rework cycle.

**Enforcement:** none yet: today the G9 reviewer's independent re-run of the
body's cited commands is the enforcer that caught this (a Verified line the
re-run contradicts must go). Candidate enforcer to build: a pre-handoff check
that extracts every command the PR body cites as Pre-existing / fails-at-base
and re-runs it at the current head, failing the handoff when a stored result no
longer reproduces.

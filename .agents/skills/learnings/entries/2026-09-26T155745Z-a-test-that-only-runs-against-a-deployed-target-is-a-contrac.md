---
recorded: 2026-09-26T15:57:45Z
incident_date: 2026-09-06
---
# A test that only runs against a deployed target is a contract nobody runs before merge

**Rule:** when changing behaviour that a deployed-only spec or flow asserts —
one that `test.skip`s without a provider, or whose fixtures differ by target —
grep `tests/e2e/specs` and `tests/src/flows` for the old value in the SAME PR.
A flow must assert on the row it wrote (found by slug/id), never on `[0]` of a
list another process (a seeded starter, a background writer) can also
populate. A read that follows a managed-git write must settle (two equal
reads) before it is compared against an earlier snapshot. Before promoting,
dispatch the deployed-target suite against staging as a dry run — for tests
gated to run only against a deployed target, the release gate is the first
time they see the change.

**Trigger surface:** any change to a value, slug format, or seed behaviour
that a `tests/e2e/specs` spec or `tests/src/flows` flow asserts only when
targeting a deployed environment.

**Incident:** v0.13.11 release gate, 2026-09-05/06: four deployed-only tests
went red while every PR lane had been green for a week. A connector slug
format change broke a spec still asserting the old fixed slug; managed repos
began seeding a starter project by default, so a flow reading `triggers[0]`
read the starter's seeded cron instead of the row it had just created; a
manifest-history read compared against a write that had not yet settled
through the git mirror. ~2h of release delay, no user impact.

**Enforcement:** none yet — the staging dry-run dispatch is manual practice,
not automated.

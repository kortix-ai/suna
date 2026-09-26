---
recorded: 2026-09-26T17:51:04Z
incident_date: 2026-09-26
---
# The blocked-terms guard is a local hook, not a gate: scrub customer names that reach main in the next branch that merges it

**Rule:** treat `scripts/check-blocked-terms.sh` as a local hook only. When it refuses a merge of `main`, replace
the name with its class ("a customer deployment") in that merge, name the `main` SHA in the commit
message, and report it. Never bypass the guard with `--no-verify`.

**Trigger surface:** merging `main` into a branch; writing an incident story into a test comment.

**Incident:** 2026-09-26. A test comment on `main` (`9fc6084368`, #7180) named a customer. This was the
second time in two days: #7673 scrubbed a deployment hostname that `cd6b6ab7af` (#7403) had added. Both
landed through pull requests. The guard runs only in `.githooks`: it allows a push when the author's
machine has no `apps/api/.env.keys`, and a squash merge on GitHub never runs it. The next branch that
merged `main` found each one.

**Enforcement:** none yet. To build: a required CI check that decrypts `BLOCKED_COMMIT_TERMS` and runs the
guard over the PR diff, title and body, so a term fails before the merge instead of after it.

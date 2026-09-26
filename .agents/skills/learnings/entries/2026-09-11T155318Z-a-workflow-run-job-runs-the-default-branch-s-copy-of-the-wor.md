---
recorded: 2026-09-11T15:53:18Z
incident_date: 2026-09-10
commit: 99f61eb619
---
# A `workflow_run` job runs the DEFAULT BRANCH's copy of the workflow, not the branch it is deploying

**When:** a workflow triggered by `workflow_run:` verifies or deploys another
branch. `deploy-staging.yml` fires on `workflow_run` after Build Staging
Artifacts. GitHub loads that YAML from the DEFAULT branch (`main`), while the
job checks out and deploys `staging`. So staging can hold a corrected workflow
and still be verified by main's stale one. Here staging's copy asserted the
HOST-ONLY access cookie (correct since #7065 stopped `.kortix.com` sending
dev's cookie to staging, prod and api.kortix.com alike); main's copy still
demanded the parent-domain cookie the app deliberately no longer sets. The
staging deploy for `40c750d5d6` deployed everything correctly and then failed
its own verification, blocking the promote — while the previous deploy of the
same code had PASSED because it ran via `workflow_dispatch`, which uses the
selected branch's file. Same workflow, same environment, opposite verdicts,
decided only by trigger type. **Rules.** (1) A fix to a `workflow_run` workflow
is not live until it is on the DEFAULT branch — landing it on the branch under
test changes nothing. (2) When a `workflow_run` deploy fails a check its
`workflow_dispatch` twin passes, diff the workflow file between the two
branches before touching anything else. (3) An assertion about a security
property must be re-read when that property is deliberately changed; this one
asserted the exact bug #7065 removed. *Incident:* v0.13.14 promote blocked,
2026-09-10; second occurrence (v0.13.11, 2026-09-05, PR #7137 still open).
*Enforcer:* the assertion now also REFUSES a `.kortix.com` row, so a #7065
regression fails loudly instead of silently satisfying the old rule.

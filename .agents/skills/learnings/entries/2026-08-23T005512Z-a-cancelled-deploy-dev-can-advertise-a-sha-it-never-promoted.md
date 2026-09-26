---
recorded: 2026-08-23T00:55:12Z
commit: 83d0780844
---
# A cancelled deploy-dev can advertise a SHA it never promoted, and the next run then skips that surface

2026-08-23. `deploy-dev` run 32605966965 (`e6c4ba0b62`, an `apps/web`-only
change) was cancelled by a newer merge while in flight. Its per-surface jobs
did not all die together: `Build frontend image` and `Deploy frontend to dev
(ECS Fargate)` both reported `success`, while `Move :dev → this build
(frontend)` and `Verify canonical Dev frontend on ECS` were cancelled. The next
run (32606271039, `dbe5999884`) resolved the deploy base and logged `Comparing
changed surfaces against deployed dev SHA e6c4ba0b62…` — the SHA the cancelled
run had advertised — concluded the frontend was current, and printed
`Build frontend image (amd64): skipped` / `Deploy frontend to dev: skipped`.
`https://dev.kortix.com/api/health` still reported `commit 2ff469ed`'s
predecessor at that moment. A later unrelated merge happened to touch the
frontend and carried the stranded change out; nothing in the pipeline would
have.

**The rule.** "The next push re-picks-up your still-stale surface" is only true
while the staleness probe reports what is actually SERVING. A cancelled run can
move the probe's answer past a surface it never promoted, and every later run
then reads that surface as fresh. After a cancelled `deploy-dev`, never assume
the next merge carries your surface — read the cancelled run's PER-JOB
conclusions, and if the `Move :dev` / `Verify canonical` step for your surface
was cancelled, force it: `gh workflow run deploy-dev.yml -f surface=all`.

**The enforcement.** Verify by ARTIFACT CONTENT, never by run conclusion or by
`/health` alone: fetch the deployed surface and grep it for a string only your
change introduces. For `apps/web`, load the route in a browser, collect
`performance.getEntriesByType('resource')` `/_next/*.js`, fetch each and assert
both the string your change ADDS and the absence of the one it REMOVES — the
pair is what distinguishes "deployed" from "an older bundle that happens to
contain a similar token". Candidate pipeline fix: make the deploy base come
from each surface's own live artifact, and never let a surface's SHA advance
past its `Move :dev` step.

*Incident:* PR #6764, merge `e6c4ba0b62`, 2026-08-22 23:43 UTC. No outage —
a frontend-only fix sat undeployed on dev for ~25 minutes while both the run
list and the deployed-SHA probe read as healthy.

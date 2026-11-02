---
recorded: 2026-10-30T20:29:27Z
incident_date: 2026-10-30
---
# Pin always() on every post-deploy verify job, not only on promotions

**Rule:** In `.github/workflows/deploy-dev.yml`, every job that verifies or promotes a deployed surface starts its `if:` with `always()` and checks its direct prerequisite's `result == 'success'`. A plain `if:` inherits a skipped ancestor such as `terraform-dev-api`, which skips whenever no dev Terraform changed. This extends the 2026-08-24 rule to the verify jobs.

**Trigger surface:** Adding or editing a deploy, verify or `:dev` promotion job in `deploy-dev.yml`.

**Incident:** 2026-10-30, deploy run 41119654145 (PRs #11236 and #11230): the gateway deployed and served the merge SHA, but `verify-gateway-dev-parity` skipped, so the PR comments said "Not live on dev yet" and `promote-dev-channel-gateway` left the self-host `:dev` gateway on the previous image. Every deploy that changed the gateway without a Terraform change hit it.

**Enforcement:** `tests/unit/dev-channel-promotion-workflow.test.ts` ("Deploy Dev post-deploy verification") pins the `verify-gateway-dev-parity` condition.

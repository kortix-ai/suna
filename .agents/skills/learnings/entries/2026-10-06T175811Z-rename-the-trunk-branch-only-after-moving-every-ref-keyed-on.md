---
recorded: 2026-10-06T17:58:11Z
incident_date: 2026-10-06
---
# Rename the trunk branch only after moving every ref keyed on its name: OIDC sub trust, environment branch policies, rulesets, workflow triggers, raw URLs

**Rule:** Before a branch rename or delete, grep `.github/`, `infra/terraform/`, `scripts/`, and `apps/web` for the old name. List the GitHub settings keyed on it: environment deployment-branch policies, rulesets, branch protection. Move each one in the same change, then delete the old branch.

**Trigger surface:** Renaming or replacing the default branch; adding a workflow that trusts `refs/heads/<name>`.

**Incident:** 2026-10-06, trunk `main` deleted and `dev` made default. The `dev`, `infra-global`, and `staging` environments admitted only `main`. The push-protection ruleset covered only `main`, so `dev` had no protection. Two OIDC roles trusted `ref:refs/heads/main`. Install URLs pointed at `raw.githubusercontent.com/.../main/`.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` pins the workflow triggers to `dev`. Settings and IAM trust have no automated check: none yet, build a drift test that lists environment policies and rulesets.

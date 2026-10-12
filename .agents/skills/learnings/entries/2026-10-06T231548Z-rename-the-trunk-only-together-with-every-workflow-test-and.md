---
recorded: 2026-10-06T23:15:48Z
incident_date: 2026-10-06
---
# Rename the trunk only together with every workflow, test and hook that names it, and prove one deploy of each kind after

**Rule:** A branch rename is a code change. Before deleting the old branch, change every reference to it in `.github/workflows` (`branches:`, `refs/heads/…` conditions, `--ref`, `--base`, `ref:`, `trusted_branch:`), in tests that pin workflow text, and in `.githooks`. After the rename, run one Deploy Dev and read every job's conclusion. A job that the branch name gates is `skipped`, not `failed`.

**Trigger surface:** Renaming or deleting `main`, `dev`, `staging` or `prod`. Changing a workflow's branch filter or `github.ref` condition. Moving a deploy to a new region, where a secret's region changes in the same way.

**Incident:** 2026-10-06. `main` was renamed to `dev` at 17:44Z. Every Deploy Dev run on `dev` skipped `Apply dev API Terraform`, `Apply dev web Terraform` and `Announce live on dev`, because they were gated on `github.ref == 'refs/heads/main'`. The run still reported success. Push-triggered guards (`secret-scan`, `secrets-guard`, `db-migrations`, `terraform-apply-global`, `i18n-catalogs`) stopped running on the trunk. `deploy-prod`'s post-release VERSION sync and `build-staging`'s manual dispatch named the deleted branch. Fixed in #9268, #9270, #9274 and #9276. The first restored Terraform apply then failed with `couldn't find remote ref refs/heads/main` (`trusted_branch: main`). The same day, #9254 moved staging to eu-west-2 and set the Vercel job's secret region to eu-west-2. The shared `kortix-ci-env` blob lives in us-west-2, so staging web did not deploy (#9293).

**Enforcement:** none yet. Build a `tests/unit` check that fails when any workflow names a branch other than `dev`, `staging` or `prod`. `tests/unit/sandbox-workflow.test.ts` pins the `dev` filters today. `aws-env-action.test.ts` does not check secret regions.

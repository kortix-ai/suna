---
recorded: 2026-11-03T21:19:15Z
incident_date: 2026-11-03
---
# Before renaming the GitHub repository, add the new name to every AWS OIDC trust and apply it

**Rule:** GitHub writes a repository's current name into the OIDC `sub` claim.
Before a rename, add the new name to `local.github_repos` in
`infra/terraform/security-baseline/github-repos.tf` and apply it with an MFA
session. CI cannot apply it after the rename: the Terraform apply role is
locked out by the same claim.

**Trigger surface:** renaming or transferring the GitHub repository; any
`token.actions.githubusercontent.com:sub` condition in `infra/terraform`.

**Incident:** 2026-11-03. The repository was renamed from `kortix-ai/suna` to
`kortix-ai/CompanyOS`. Every job that logs in to AWS failed with `Not authorized
to perform sts:AssumeRoleWithWebIdentity`: dev deploy runs 41715059000 and
41715300856 (API and frontend images, DB migrations). dev kept serving
`520f8ca9c6`, so merged fixes (#11639, #11651) did not reach dev. Staging and
prod deploys use the same roles. Fix: #11650 trusts both names; it needs a
manual `terraform apply` in `security-baseline`.

**Enforcement:** `tests/unit/prod-deploy-trust.test.ts` requires the prod role to
derive its subject from `local.github_repos` and that list to hold the current
name. None yet: a check that compares the list with the live repository name
(`gh api repos/<owner>/<repo> --jq .full_name`) in a scheduled job.

---
recorded: 2026-11-03T23:02:54Z
incident_date: 2026-11-03
---
# Trust the repository's immutable OIDC subject, and move every name-pinned publisher, before a repository rename

**Rule:** This repository issues immutable OIDC subjects (`gh api repos/kortix-ai/CompanyOS/actions/oidc/customization/sub` → `use_immutable_subject: true`). `sub` is `repo:kortix-ai@170767358/CompanyOS@868173144:<context>`, by owner and repository id, not by name. Every AWS trust lists that id form (`local.github_repos` in `infra/terraform/security-baseline/github-repos.tf`). Read the real subject from CloudTrail (`AssumeRoleWithWebIdentity` events, `userIdentity.userName`) before writing a trust. Before a rename, also move every publisher that pins the repository NAME: npm Trusted Publishing on each published package (`npm trust github <pkg> --repo <owner/new> --file deploy-prod.yml`, npm 12+, approved in the browser), and anything else that names the repository. After a manual apply, no older queued `terraform-apply-global` run may follow it: such a run applies its own commit's trust and reverts the manual one.

**Trigger surface:** renaming or transferring the GitHub repository; any `token.actions.githubusercontent.com:sub` condition; npm Trusted Publisher settings; `terraform-apply-global.yml` runs queued behind a manual apply.

**Incident:** 2026-11-03, about 20:44 to 23:10 UTC. The repository was renamed `kortix-ai/suna` → `kortix-ai/CompanyOS`. Every AWS login from Actions failed (`AccessDenied`): dev, staging and prod deploys, DB migrations, the release suite, Drata. #11650 trusted the new NAME and was applied, but no token carries the name, so nothing recovered. CloudTrail showed the id form. #11656 added it and it was applied with an MFA session at 21:44. A global apply queued at 21:42 for an older commit (#11654) then ran until 22:01 with the restored access and reverted the trust. The v0.14.18 prod rollout started at 21:59 and failed on migrations, the image retag and Terraform. A second manual apply at 22:12, then a clean CI global apply ("No changes" in security-baseline), restored it. npm then refused all 4 package publishes (E404): Trusted Publishing still named `kortix-ai/suna`. It was moved per package with `npm trust github`, approved in Marko's browser through `ptxp local open`.

**Enforcement:** `tests/unit/prod-deploy-trust.test.ts` (the prod role derives its subjects from `local.github_repos`). None yet: a scheduled job that compares `local.github_repos` with the live OIDC customization (`sub_claim_prefix`) and with each package's `npm trust list`.

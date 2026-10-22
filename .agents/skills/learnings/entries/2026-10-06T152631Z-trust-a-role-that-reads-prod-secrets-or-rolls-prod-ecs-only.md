---
recorded: 2026-10-06T15:26:31Z
incident_date: 2026-10-06
---
# Trust a role that reads prod secrets or rolls prod ECS only through a GitHub environment subject, never repo:*

**Rule:** An AWS OIDC role with prod secret or prod ECS permission trusts `repo:kortix-ai/suna:environment:prod` only. Every job that assumes it declares `environment: prod`. A `repo:kortix-ai/suna:*` trust holds CI-blob permission only. Deploy a trust split in two phases: add the new role, ship the workflows that use it to the `prod` branch with a release, then remove the old grants.

**Trigger surface:** Editing `infra/terraform/security-baseline/iam-gha-*.tf`, `.github/actions/aws-env`, or any workflow that reads `kortix-prod-*` or rolls a prod ECS service.

**Incident:** Audit 2026-10-06. `kortix-gha-ecs-deploy` trusted `repo:kortix-ai/suna:*` and read `kortix-prod-env`. Any branch or pull request workflow with `id-token: write` could read the prod `DATABASE_URL` and roll prod ECS. `deploy-prod.yml` also ran from any dispatched ref. The `prod` environment branch policy never applied because no job declared the environment.

**Enforcement:** `tests/unit/prod-deploy-trust.test.ts` pins the role trust and `environment: prod` on every prod-role job. Phase 2 (strip the prod grants from the broad role) is open until the release that puts the new workflows on `prod`.

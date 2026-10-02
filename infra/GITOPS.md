# ECS Fargate release pipeline

Kortix deploys the API, gateway, and frontend through GitHub Actions to Amazon
ECS Fargate. Terraform owns the persistent networks, load balancers, services,
autoscaling policies, DNS records, IAM roles, and Secrets Manager resources.

The filename remains `GITOPS.md` because existing links use it. Argo CD, EKS,
Helm, and Kubernetes are not part of the current deployment path. Commit
`11c1d2dd4d` decommissioned those resources on 2026-08-02.

## Environments

| Environment | Source | API | Frontend | Vercel status |
| --- | --- | --- | --- | --- |
| Preview | PR with `preview` label | one Platinum sandbox per PR | the same sandbox | Disabled |
| Dev | `main` | `dev-api.kortix.com` | `dev.kortix.com` on ECS | Disabled |
| Staging | `staging` | `staging-api.kortix.com` | `staging-fe-ecs.kortix.com` on ECS | `staging.kortix.com` |
| Production | `prod` | `api.kortix.com` | `prod-fe-ecs.kortix.com` on ECS | `kortix.com` |

Dev is ECS-only. Previews run in a Platinum sandbox, not on ECS. Staging and production retain their parallel
Vercel and `*-fe-ecs.kortix.com` paths.

## Deployment workflows

| Workflow | Role |
| --- | --- |
| `deploy-preview.yml` | Builds PR-specific API, gateway, and frontend images. It boots them in one Platinum sandbox per pull request (`tests/bin/sandbox-preview.ts`). It removes the sandbox after unlabel or close. |
| `deploy-dev.yml` | Builds changed dev images, applies dev migrations, rolls the changed ECS services, publishes canonical frontend DNS, and verifies ECS. |
| `build-staging.yml` | Builds immutable staging release-candidate images. |
| `deploy-staging.yml` | Applies staging migrations, rolls staging ECS services, and verifies the staging targets. |
| `promote.yml` | Opens a reviewed release PR from staging into `prod`. It does not deploy. |
| `deploy-prod.yml` | Retags tested staging images, applies production migrations, rolls production ECS services, publishes the release, and verifies the live version. |
| `rollback-prod.yml` | Rolls selected production ECS services to existing immutable release images. It can also promote the matching Vercel frontend deployment. |

## Preview lifecycle

Adding the `preview` label to a pull request starts the preview workflow.

Only a repository writer or administrator can approve a preview. The label
approves the exact head SHA. A new commit tears down the old preview and removes
the label. A writer or administrator must review the new SHA and reapply it.

1. Three unprivileged jobs build fixed-tag API, gateway, and frontend archives.
   They receive no Docker Hub, AWS, or application secrets.
2. A trusted job publishes the archives without starting their containers.
3. The trusted job boots the full self-host distribution in one Platinum
   sandbox for the pull request (`tests/bin/sandbox-preview.ts deploy`).
4. One sticky pull-request comment publishes the preview URLs.

Removing the label or closing the pull request deletes the sandbox. The
procedure is in the `contributing` skill
(`.agents/skills/contributing/references/preview-environments.md`).

The per-PR ECS preview runtime (`environments/preview`, `ecs-preview.sh`) was
retired by #6347 and deleted in 2026-09.

## Runtime configuration

Each permanent environment stores one JSON environment document in AWS Secrets
Manager. `infra/scripts/ecs-deploy.sh` injects the document through
`KORTIX_ENV_JSON`. The frontend uses a separate `kortix-<env>-web-env` secret.

Dev and staging use the same `WEB_PROTECTION_USERNAME` and
`WEB_PROTECTION_PASSWORD` values. The password value is never committed in
plaintext. It lives in dotenvx-encrypted environment files, GitHub Actions
secrets, and AWS Secrets Manager.

### Sandbox compute placement

When available, a project's `us_region` flag places newly provisioned Platinum
sandboxes in `KORTIX_PLATINUM_US_REGION`. API, database, and S3 archive regions
do not override that compute preference. Disabling the flag uses the provider's
home region; existing sandboxes retain their placement, including on restart.

Warm-session adoption requires provider-reported placement matching the current
project flag. Server-owned placement intent only deduplicates in-flight warming;
it is not proof that a sandbox is ready or in the requested region.

## Rollback

`rollback-prod.yml` validates that each requested release image exists. It then
registers new task-definition revisions and rolls the selected ECS services.
The workflow does not reverse database migrations. Forward-only migrations must
remain compatible with the selected application version.

Run the workflow with:

```bash
gh workflow run rollback-prod.yml --repo kortix-ai/suna --ref main \
  -f version=vX.Y.Z \
  -f reason="<incident>" \
  -f confirm="ROLLBACK PROD"
```

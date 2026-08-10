# ECS Fargate release pipeline

Kortix deploys the API, gateway, and frontend through GitHub Actions to Amazon
ECS Fargate. Terraform owns the persistent networks, load balancers, services,
autoscaling policies, DNS records, IAM roles, and Secrets Manager resources.

The filename remains `GITOPS.md` because existing links use it. Argo CD, EKS,
Helm, and Kubernetes are not part of the current deployment path. Commit
`11c1d2dd4d` decommissioned those resources on 2026-08-02.

## Environments

| Environment | Source | API | ECS frontend | Vercel frontend |
| --- | --- | --- | --- | --- |
| Preview | PR with `preview` label | `pr-<number>.preview-api.kortix.com` | `pr-<number>.preview.kortix.com` | PR-specific Vercel URL |
| Dev | `main` | `dev-api.kortix.com` | `dev-fe-ecs.kortix.com` | `dev.kortix.com` |
| Staging | `staging` | `staging-api.kortix.com` | `staging-fe-ecs.kortix.com` | `staging.kortix.com` |
| Production | `prod` | `api.kortix.com` | `prod-fe-ecs.kortix.com` | `kortix.com` |

The permanent Vercel hostnames remain active during the ECS frontend migration.
The `*-fe-ecs.kortix.com` hostnames provide parallel ECS validation.

## Deployment workflows

| Workflow | Role |
| --- | --- |
| `deploy-preview.yml` | Builds PR-specific API, gateway, and frontend images. It deploys an isolated ECS service and a parallel Vercel preview. It verifies both paths and removes resources after unlabel or close. |
| `deploy-dev.yml` | Builds changed dev images, applies dev migrations, rolls the changed ECS services, and verifies the ECS and Vercel frontend paths. |
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
   They receive no Docker Hub, AWS, Vercel, or application secrets.
2. A trusted job publishes the archives without starting their containers.
3. Terraform creates PR-specific listener rules, target groups, and DNS records.
4. The workflow deploys one ECS Fargate service for the pull request.
5. The workflow creates the parallel Vercel preview.
6. Verification checks the API commit, frontend commit, runtime URLs, password
   gate, shared parent-domain cookie, and black-box API flows.
7. One sticky pull-request comment publishes the API, health, ECS frontend, and
   Vercel frontend URLs.

Removing the label or closing the pull request destroys the ECS service, task
definitions, listener rules, target groups, DNS records, and Vercel branch
configuration. A daily reconciliation run removes leaked preview resources.

Preview compute is isolated per pull request. Preview database and Supabase
state are shared with dev.

## Runtime configuration

Each permanent environment stores one JSON environment document in AWS Secrets
Manager. `infra/scripts/ecs-deploy.sh` injects the document through
`KORTIX_ENV_JSON`. The frontend uses a separate `kortix-<env>-web-env` secret.
Preview uses `kortix-preview-web-env`. It excludes Edge Config and Vercel
credentials.

Preview, dev, and staging use the same `WEB_PROTECTION_USERNAME` and
`WEB_PROTECTION_PASSWORD` values. The password value is never committed in
plaintext. It lives in dotenvx-encrypted environment files, GitHub Actions
secrets, and AWS Secrets Manager.

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

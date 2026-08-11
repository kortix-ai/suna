# Terraform roots — what CI applies, and what it does not

Every directory with a `backend.tf` is a Terraform root. Until 2026-08-10 CI
applied exactly one of them (`environments/prod-us-east-2-shadow`, from
`deploy-prod-us-east-2-shadow.yml`); the rest were applied by hand. Merged
infrastructure could therefore sit unapplied indefinitely, and on 2026-08-10 two
merged compliance PRs (#6295, #6344) did exactly that for several hours. Since
2026-08-11 every root that a deploy touches is applied by CI.

`.github/workflows/terraform-apply.yml` is the reusable, guarded apply. This
table is the source of truth for which root it drives.

| Root | Applied by | Trigger | Region | OIDC role |
| --- | --- | --- | --- | --- |
| `environments/dev` | `deploy-dev.yml` -> `terraform-dev-api` | push to `main` touching `environments/dev{,-web}/**`, `modules/**`, or either workflow | `us-west-2` | `kortix-gha-tf-apply-dev` |
| `environments/dev-web` | `deploy-dev.yml` -> `terraform-dev` | same trigger, applied after `environments/dev` | `us-west-2` | `kortix-gha-tf-apply-dev` |
| `environments/staging` | `deploy-staging.yml` -> `terraform-staging` | every staging deploy | `us-west-2` | `kortix-gha-tf-apply-staging` |
| `environments/staging-web` | `deploy-staging.yml` -> `terraform-staging-web` | every staging deploy | `us-west-2` | `kortix-gha-tf-apply-staging` |
| `environments/prod` | `deploy-prod.yml` -> `terraform-prod-api` | every production release | `eu-west-2` | `kortix-gha-tf-apply-prod` |
| `environments/prod-web` | `deploy-prod.yml` -> `terraform-prod` | every production release, after `environments/prod` | `eu-west-2` | `kortix-gha-tf-apply-prod` |
| `compliance-monitoring` | `terraform-apply-global.yml` | push to `main` touching the root | `us-west-2` | `kortix-gha-tf-apply-global` |
| `security-baseline` | `terraform-apply-global.yml` | push to `main` touching the root | `us-west-2` | `kortix-gha-tf-apply-global` |
| `environments/prod-us-east-2-shadow` | `deploy-prod-us-east-2-shadow.yml` | release | `us-east-2` | `kortix-gha-prod-use2-terraform` |
| **`environments/preview`** | **nobody — apply by hand** | — | `us-west-2` | — |

Every root above, applied or not, is planned nightly by the `drift detection`
matrix in `terraform-ci.yml`, so an unapplied change still shows up as drift.

`environments/preview` is the one remaining manual root, by design: it declares
`postgres_egress_cidrs` with no default and a validation that rejects
`0.0.0.0/0`, so the operator states the allowed CIDRs on a reviewed plan. It is
a one-off bootstrap for the PR-preview control plane, not a per-deploy root.

## `api_image` is the only input CI supplies

`environments/dev` and `environments/prod` were manual until 2026-08-11 because
each read a `terraform.tfvars` that is gitignored (`.gitignore:133`,
`infra/terraform/**/*.tfvars`) and lived only on an operator laptop. Every value
in those two files now sits in a committed variable default, so CI plans exactly
what the operator planned. Both `terraform.tfvars.example` files are gone: there
is nothing left to copy.

The single exception is `api_image`. It changes on every deploy, so a committed
pin goes stale the moment the next image ships, and a stale pin seeds a
task-definition pointing at a release nobody runs. The caller passes it instead,
through `terraform-apply.yml`'s `api_image` input (exported as
`TF_VAR_api_image`, which outranks the variable default):

| Root | Value | Source |
| --- | --- | --- |
| `environments/dev` | `kortix/kortix-api:dev-<sha8>` | `deploy-dev.yml` -> `needs.tag-api.outputs.image`, falling back to the committed `:dev-latest` when no API image was built |
| `environments/prod` | `kortix/kortix-api:<version>` | `deploy-prod.yml` -> `needs.version.outputs.version` |

`api_secrets` is committed from the operator files, minus the keys of the
retired hosted-deployment vendor and the retired Apps experiment flag (3 in dev,
2 in prod), which
`apps/api/src/__tests__/unit-hosted-deployment-vendor-removal.test.ts` forbids in
any tracked file. Nothing reads them, and they remain in the env blob that ECS
actually injects. Everything else is verbatim.

`api_secrets` is inert today — both roots pass `secrets_blob_arn`, and
`modules/ecs-api` reads `var.secrets` only when that is empty (`main.tf:134` for
the execution-role Resource list, `main.tf:459` for the container definition) —
but it stays exact so removing the blob cannot silently drop a key. In prod that
key is `MANAGED_GIT_GITHUB_TOKEN`, whose absence 502s every
`POST /v1/projects/provision`.

Never commit a `terraform.tfvars` here. The committed defaults hold config and
Secrets Manager ARNs only; the values behind those ARNs stay in Secrets Manager,
readable only by the task execution role.

## Bootstrap

The four `kortix-gha-tf-apply-*` roles live in
`security-baseline/iam-gha-tf-apply.tf`, which is itself applied by one of those
roles. Break the cycle once, by hand:

```bash
cd infra/terraform/security-baseline
terraform init
terraform apply
terraform output -json | jq -r 'to_entries[] | select(.key | startswith("gha_tf_apply_role_arn")) | "\(.key)\t\(.value.value)"'
```

Then set the repository variables (`gh variable set`):

| Variable | Output |
| --- | --- |
| `TF_APPLY_ROLE_ARN_DEV` | `gha_tf_apply_role_arn_dev` |
| `TF_APPLY_ROLE_ARN_STAGING` | `gha_tf_apply_role_arn_staging` |
| `TF_APPLY_ROLE_ARN_PROD` | `gha_tf_apply_role_arn_prod` |
| `TF_APPLY_ROLE_ARN_GLOBAL` | `gha_tf_apply_role_arn_global` |

Each role's trust policy pins the OIDC subject to a GitHub **environment**, so
the environments must exist. Give each one a deployment-branch restriction too:

| Environment | Deployment branch | Used by |
| --- | --- | --- |
| `dev` | `main` | `deploy-dev.yml` |
| `staging` | `staging` | `deploy-staging.yml` |
| `prod` | `prod` | `deploy-prod.yml` |
| `infra-global` | `main` | `terraform-apply-global.yml` |

The branch restriction is defence in depth, not the primary control.
`terraform-apply.yml` takes a required `trusted_branch` input and refuses to
mint AWS credentials unless the checked-out commit is reachable from
`origin/<trusted_branch>`. That guard runs in-workflow, before
`configure-aws-credentials`, and therefore holds even if the environment is
misconfigured. It is what stops a `workflow_dispatch` from an arbitrary branch
applying attacker-authored Terraform with the production role.

Do **not** add required reviewers to `prod`. `deploy-prod.yml` runs unattended
after a reviewed release PR merges; a reviewer gate there pauses every release
at the Terraform step.

Until those variables are set, every apply job skips and the image deploys still
run. `terraform-ci.yml`'s `apply-pipeline-health` job fails on the daily
schedule while any of them is unset, so the skip cannot go unnoticed.

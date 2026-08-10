# Terraform roots — what CI applies, and what it does not

Every directory with a `backend.tf` is a Terraform root. Until 2026-08-10 CI
applied exactly one of them (`environments/prod-us-east-2-shadow`, from
`deploy-prod-us-east-2-shadow.yml`); the rest were applied by hand. Merged
infrastructure could therefore sit unapplied indefinitely, and on 2026-08-10 two
merged compliance PRs (#6295, #6344) did exactly that for several hours.

`.github/workflows/terraform-apply.yml` is the reusable, guarded apply. This
table is the source of truth for which root it drives.

| Root | Applied by | Trigger | Region | OIDC role |
| --- | --- | --- | --- | --- |
| `environments/dev-web` | `deploy-dev.yml` -> `terraform-dev` | push to `main` touching `environments/dev-web/**` or `modules/**` | `us-west-2` | `kortix-gha-tf-apply-dev` |
| `environments/staging` | `deploy-staging.yml` -> `terraform-staging` | every staging deploy | `us-west-2` | `kortix-gha-tf-apply-staging` |
| `environments/staging-web` | `deploy-staging.yml` -> `terraform-staging-web` | every staging deploy | `us-west-2` | `kortix-gha-tf-apply-staging` |
| `environments/prod-web` | `deploy-prod.yml` -> `terraform-prod` | every production release | `eu-west-2` | `kortix-gha-tf-apply-prod` |
| `compliance-monitoring` | `terraform-apply-global.yml` | push to `main` touching the root | `us-west-2` | `kortix-gha-tf-apply-global` |
| `security-baseline` | `terraform-apply-global.yml` | push to `main` touching the root | `us-west-2` | `kortix-gha-tf-apply-global` |
| `environments/prod-us-east-2-shadow` | `deploy-prod-us-east-2-shadow.yml` | release | `us-east-2` | `kortix-gha-prod-use2-terraform` |
| **`environments/dev`** | **nobody — apply by hand** | — | `us-west-2` | — |
| **`environments/prod`** | **nobody — apply by hand** | — | `us-west-2` | — |
| **`environments/preview`** | **nobody — apply by hand** | — | `us-west-2` | — |

Every root above, applied or not, is planned nightly by the `drift detection`
matrix in `terraform-ci.yml`, so an unapplied change still shows up as drift.

## TODO: make `environments/dev` and `environments/prod` auto-appliable

Both roots read a `terraform.tfvars` that is gitignored
(`.gitignore:133`, `infra/terraform/**/*.tfvars`) and lives only on an operator
laptop. Their committed `terraform.tfvars.example` files diverge from the
variable defaults:

- `environments/dev/terraform.tfvars.example` sets a non-empty `api_environment`
  (`KORTIX_URL`, `ALLOWED_SANDBOX_PROVIDERS`).
- `environments/prod/terraform.tfvars.example` sets `api_environment` and pins
  `api_image` to an immutable release tag rather than the `:latest` default.

`environments/staging` is auto-applied precisely because its example file is
identical to the defaults (`api_environment = {}`, `manage_dns = false`), so CI
plans exactly what an operator plans.

The unblock is small and worth doing:

1. `api_image`, `gateway_image`, `api_environment`, `api_secrets`, and
   `gateway_environment` only reach `aws_ecs_task_definition.container_definitions`,
   which `modules/ecs-api/main.tf:473` marks `ignore_changes`. `ecs-deploy.sh`
   has owned every revision after the first since that lifecycle block landed,
   so these five variables are inert for an existing environment. Confirm that
   against a real `terraform plan -detailed-exitcode` with no tfvars file
   present, on both roots.
2. If the plan is empty, delete the five variables from the two
   `terraform.tfvars.example` files and add both roots to the apply pipeline —
   `environments/dev` to `deploy-dev.yml`, `environments/prod` to
   `deploy-prod.yml`, mirroring the existing `*-web` jobs.
3. If the plan is not empty, move the differing inputs into workflow-supplied
   `-var` arguments or into the environment's Secrets Manager blob, then repeat
   step 1.

Do not shortcut this by committing a `terraform.tfvars`: the prod file
references Secrets Manager ARNs and is intentionally out of git.

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

# Terraform roots — what CI applies, and what it does not

Every directory with a `backend.tf` is a Terraform root. Until 2026-08-10 CI
applied exactly one of them (the us-east-2 prod shadow, removed 2026-10-12);
the rest were applied by hand. Merged
infrastructure could therefore sit unapplied indefinitely, and on 2026-08-10 two
merged compliance PRs (#6295, #6344) did exactly that for several hours. Since
2026-08-11 every root that a deploy touches is applied by CI.

`.github/workflows/terraform-apply.yml` is the reusable, guarded apply. This
table is the source of truth for which root it drives.

| Root | Applied by | Trigger | Region | OIDC role |
| --- | --- | --- | --- | --- |
| `environments/dev-us-east-2` | `deploy-dev.yml` -> `terraform-dev-api` | a dev deploy whose diff touches `environments/dev-us-east-2/**`, `environments/dev-web-us-east-2/**` or `modules/**` | `us-east-2` | `kortix-gha-tf-apply-dev` |
| `environments/dev-web-us-east-2` | `deploy-dev.yml` -> `terraform-dev` | same trigger, applied after `environments/dev-us-east-2` | `us-east-2` | `kortix-gha-tf-apply-dev` |
| `environments/staging-eu-west-2` | `deploy-staging.yml` -> `terraform-staging` | every staging deploy | `eu-west-2` | `kortix-gha-tf-apply-staging` |
| `environments/staging-web-eu-west-2` | `deploy-staging.yml` -> `terraform-staging-web` | every staging deploy | `eu-west-2` | `kortix-gha-tf-apply-staging` |
| `environments/prod` | `deploy-prod.yml` -> `terraform-prod-api` | every production release | `eu-west-2` | `kortix-gha-tf-apply-prod` |
| `environments/prod-web` | `deploy-prod.yml` -> `terraform-prod` | every production release, after `environments/prod` | `eu-west-2` | `kortix-gha-tf-apply-prod` |
| `compliance-monitoring` | `terraform-apply-global.yml` | push to `dev` touching the root | `eu-west-2`, `us-east-2` (alert hub `eu-west-2` since 2026-10-12) | `kortix-gha-tf-apply-global` |
| `security-baseline` | `terraform-apply-global.yml` | push to `dev` touching the root | all 17 regions (alert hub `eu-west-2` since 2026-10-12) | `kortix-gha-tf-apply-global` |

Every root above, applied or not, is planned nightly by the `drift detection`
matrix in `terraform-ci.yml`, so an unapplied change still shows up as drift.

The "Region" column is where the resources live, and each root's state lives
in the same region (`backend.tf`, same key as before the move):

| State bucket | Roots | Defined in |
| --- | --- | --- |
| `kortix-terraform-state-eu-west-2-935064898258` | `environments/prod`, `environments/prod-web`, `environments/staging-eu-west-2`, `environments/staging-web-eu-west-2`, `security-baseline`, `compliance-monitoring` | `security-baseline/terraform-state-euw2.tf` |
| `kortix-terraform-state-us-east-2-935064898258` | `environments/dev-us-east-2`, `environments/dev-web-us-east-2` | `security-baseline/terraform-state-use2.tf` |
| `kortix-terraform-state-us-east-1-935064898258` | external: `kortix-ai/kortix-vps-demo-infra` (key `vps-demo/terraform.tfstate`) | `security-baseline/terraform-state-use1.tf` |

All three buckets are versioned, keep noncurrent versions for 365 days and encrypt
state with their own CMK. Locking is S3 native (`use_lockfile`): Terraform
writes `<key>.tflock` next to the state, so there is no lock table. The drift
role `kortix-gha-tf-plan` may decrypt with the eu-west-2 and us-east-2 state keys
through S3 only. No drift job plans the us-east-1 root.

Until 2026-10 every root kept its state in the us-west-2 bucket
`kortix-terraform-state` with the lock table `kortix-terraform-locks`. Each
root's state was copied to its regional bucket and verified by SHA-256: `dev`
and the two global roots on 2026-10-13, `staging` and `prod` on 2026-10-14 with
the promotion and release that carried #9693, and the external vps-demo root
on 2026-10-13. The old bucket, its lock table and the us-west-2 AWS Backup vaults
that protected the table were deleted afterwards. No root reads us-west-2 state.

The us-west-2 roots `dev`, `dev-web`, `staging` and `staging-web`
were destroyed on 2026-10-12 (dev 58, dev-web 2, staging 74, staging-web 19
resources) and removed from the repository. Their stacks moved to the
`-us-east-2` and `-eu-west-2` roots above. The us-east-2 prod shadow root
`prod-us-east-2-shadow` was removed the same day; it had not run since
2026-08.

## `api_image` is the only input CI supplies

The old us-west-2 dev root and `environments/prod` were manual until 2026-08-11 because
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
| `environments/dev-us-east-2` | `kortix/kortix-api:dev-<sha8>` | `deploy-dev.yml` -> `needs.tag-api.outputs.image`, falling back to the committed `:dev-latest` when no API image was built |
| `environments/prod` | `kortix/kortix-api:<version>` | `deploy-prod.yml` -> `needs.version.outputs.version` |

`api_secrets` in `environments/prod` is committed from the operator file, minus
the keys of the retired hosted-deployment vendor and the retired Apps experiment
flag (2 keys), which
`apps/api/src/__tests__/unit-hosted-deployment-vendor-removal.test.ts` forbids in
any tracked file. Nothing reads them, and they remain in the env blob that ECS
actually injects. Everything else is verbatim.

`api_secrets` is inert today — the root passes `secrets_blob_arn`, and
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
| `dev` | `dev` | `deploy-dev.yml` |
| `staging` | `staging` | `deploy-staging.yml` |
| `prod` | `prod` | `deploy-prod.yml` |
| `infra-global` | `dev` | `terraform-apply-global.yml` |

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

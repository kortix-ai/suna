# Terraform apply pipeline

Every Terraform change goes through one path: pull request → read-only plan
comment → review → merge → guarded apply → nightly drift check. No operator
applies from a laptop, except the bootstrap below and `environments/preview`.
`infra/terraform/README.md` has the root-by-root table.

## The path

1. **Pull request.** `terraform-ci.yml` job `plan` plans every root the change
   affects (`infra/terraform/scripts/terraform_roots.py`). It runs the guard
   (`plan_guard.py`) in report mode. Job `plan comment` keeps one sticky
   comment, `<!-- terraform-plan -->`, with per-root action counts, every
   planned delete, and `DATA LOSS` on stateful types. The repository is public:
   the comment and the log show addresses and counts, never attribute values.
2. **Review.** A planned delete blocks the apply on `main`. When the delete is
   intended, add the label **`terraform-destroy-ok`** to the pull request
   before you merge.
3. **Merge.** `terraform-apply-global.yml` applies `compliance-monitoring`,
   then `security-baseline`. `deploy-dev.yml` applies `environments/dev` and
   `dev-web`. `deploy-staging.yml` and `deploy-prod.yml` apply their roots on
   release. Each call runs `terraform-apply.yml`: trusted-branch check, plan,
   guard, apply of the same plan file.
4. **Drift.** `terraform-ci.yml` job `drift detection` plans every root at
   07:17 UTC. Drift fails the job and names the root in the job summary.

## Deletes

| Path | How to allow a planned delete |
| --- | --- |
| push to `main`, global roots | label `terraform-destroy-ok` on the merged pull request |
| any root, manual | `gh workflow run terraform-apply-global.yml -f allow_deletes=true`, or `deploy-dev.yml` with `allow_deletes` |
| staging, prod | not automatic. Apply by hand after review. |

The label approves every delete in the plan of that merge commit. When two
merges queue, the newest merge's label decides. The guard log lists every
delete either way.

## What a human provisions

The apply roles and their variables exist since 2026-08-10
(`TF_APPLY_ROLE_ARN_{DEV,STAGING,PROD,GLOBAL}`, `TF_PLAN_ROLE_ARN`,
environments `dev`, `staging`, `prod`, `infra-global`). The pull request plan
adds three items. Do them in this order:

1. **Merge the change.** `terraform-apply-global.yml` applies
   `security-baseline` and creates the role `kortix-gha-tf-plan-pr`
   (`security-baseline/iam-gha-tf-plan-pr.tf`): ReadOnlyAccess minus secret
   values, trust subject `repo:kortix-ai/suna:environment:terraform-plan-pr`.
   Until step 3, the `plan` jobs skip and `apply pipeline health` fails.
2. **Create the GitHub environment `terraform-plan-pr`.** Settings →
   Environments → New environment. Add required reviewers (the infra owners).
   Set no deployment-branch rule: pull request refs must pass. The approval is
   the gate between pull request code and an account-wide read role.
3. **Set the repository variable.**
   ```bash
   cd infra/terraform/security-baseline
   terraform output -raw gha_tf_plan_pr_role_arn
   gh variable set TF_PLAN_PR_ROLE_ARN --repo kortix-ai/suna --body '<arn from above>'
   ```
4. **Create the label.**
   ```bash
   gh label create terraform-destroy-ok --repo kortix-ai/suna \
     --color B60205 --description "Reviewed: the Terraform apply on main may delete resources"
   ```
5. **Prove it.** Open a pull request that touches one `.tf` file. Approve the
   `terraform-plan-pr` deployment. Expect the `<!-- terraform-plan -->`
   comment. Then run `gh workflow run terraform-ci.yml` and expect
   `apply pipeline health` green.

No new secret is needed. The plan job reads the Cloudflare token from AWS
Secrets Manager (`kortix-ci-env:CLOUDFLARE_API_TOKEN`) through
`.github/actions/aws-env`, like the drift job. No tfvars are needed: every
planned root holds its values in committed defaults (`api_image` falls back to
its default in a plan).

## Known gaps

- `environments/preview` is not planned or applied by CI. It needs the
  operator input `postgres_egress_cidrs`. Its drift job fails with
  `No value for required variable`.
- `environments/prod-us-east-2-shadow` has its own workflow
  (`deploy-prod-us-east-2-shadow.yml`) and is not in the pull request plan.

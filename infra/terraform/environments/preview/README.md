# ECS PR preview runtime

This root provisions the persistent, non-production control plane for ephemeral
PR API and frontend previews. It reuses the dev VPC and NAT gateway. It does not change the
dev ECS services or any production resource.

The shared resources are:

- one ECS cluster (`kortix-preview`);
- one HTTPS ALB with certificates for `*.preview-api.kortix.com` and `*.preview.kortix.com`;
- DNS-only wildcard CNAMEs for both preview host families;
- one dedicated WAF, encrypted ALB access logs, and encrypted task logs;
- one task execution role that can read only `kortix-preview-env` and `kortix-preview-web-env`;
- one GitHub OIDC role scoped to per-PR resources in the preview cluster.

`deploy-preview.yml` creates one Fargate Spot service and task definition per
labeled PR. The API, gateway, and frontend run as three containers in one task.
The workflow creates separate API and frontend target groups and listener rules.
The gateway has no public listener. The API reaches it on `127.0.0.1:8090`.

The wildcard record is DNS-only. Cloudflare Universal SSL does not cover the
multi-level preview hostnames. TLS terminates at the ALB with ACM wildcard
certificates. The WAF protects the direct edge.

## Bootstrap

This root must be applied once before the first ECS preview workflow can assume
its role. The bootstrap is intentionally outside this PR. Use a reviewed plan
and apply from an operator session:

```bash
terraform init
terraform plan -var='postgres_egress_cidrs=["<verified-db-cidr>"]' -out=preview.tfplan
terraform apply preview.tfplan
```

The plan creates 29 shared non-production resources in account `935064898258`,
region `us-west-2`. It reads the existing dev VPC, `kortix-preview-env` secret,
GitHub OIDC provider, and ACM certificate. It must not target a production VPC,
secret, certificate, or DNS record. Resolve the current shared preview database
endpoint before planning. Pass only its operator-verified CIDR values through
`postgres_egress_cidrs`; the variable rejects `0.0.0.0/0`.

Set `TF_VAR_cloudflare_api_token` only for this apply. Do not commit the token.
The workflow uses `pull_request_target`. It builds the approved PR SHA in three
jobs with read-only repository access and no Docker Hub, AWS, Vercel, or
application secrets. Those jobs upload fixed-tag Docker archives. A default-branch
job loads and publishes the archives without starting their containers. Only that
job receives deployment credentials. The deployed containers receive preview
runtime secrets after a repository writer or administrator applies `preview` to
that exact SHA.

A new PR commit triggers teardown and removes `preview`. The new SHA cannot build
or deploy until a repository writer or administrator reapplies the label. This
means this PR cannot bootstrap its own live preview before the workflow reaches
the default branch.
After this code reaches the default branch through an approved bootstrap, rerun
`Deploy Preview (PR)` on a labeled PR. A passing bootstrap requires all of the
following evidence:

1. `https://pr-<PR>.preview-api.kortix.com/v1/health` reports
   `environment=preview` and this PR's full commit SHA.
2. `https://pr-<PR>.preview.kortix.com/api/health` reports the same SHA.
3. The ECS frontend uses Basic auth and targets only its per-PR API.
4. The sticky PR comment contains both ECS and Vercel frontend URLs.
5. The Vercel deployment calls the per-PR backend successfully.
6. Closing or removing the label deletes the ECS service, two listener rules,
   two target groups, active task definitions, and owned Vercel variables.
7. Pushing a new commit tears down the old preview and removes `preview`.

The shared Terraform root remains after per-PR teardown.

## Existing-resource import

Run the read-only plan first. If any resource already exists, stop. Import it
before apply rather than deleting or recreating it. Typical imports are:

```bash
terraform import aws_ecs_cluster.preview kortix-preview
terraform import aws_iam_role.execution kortix-preview-exec
terraform import aws_iam_role.task kortix-preview-task
terraform import aws_iam_role.github_preview_deploy kortix-gha-preview-deploy
terraform import aws_cloudwatch_log_group.preview /ecs/kortix-preview
```

Import the ALB, listener, security groups, WAF, DNS record, log bucket, and KMS
resources only from their exact provider IDs. Re-run `terraform plan` after every
import. Continue only when the plan contains no replacement of an existing edge,
DNS record, role, secret, VPC, or certificate.

## Cutover

1. Merge the trusted workflow and script to `main` without enabling a preview.
2. Apply the reviewed shared-root plan from an operator session.
3. Have a repository writer or administrator label one disposable internal PR
   with `preview` after reviewing its exact head SHA.
4. Require exact API SHA, `environment=preview`, Vercel `READY`, exact Vercel
   commit/branch metadata, and both branch variables targeting its PR backend.
5. Remove the label. Confirm per-PR ECS, ALB, task-definition, and owned Vercel
   resources are absent. The workflow rejects a 21st active preview by default.

The backend containers receive `kortix-preview-env`. That secret contains
provider and application credentials required by the full preview API. Applying
`preview` is therefore a security approval for that exact SHA. Do not approve
code that you do not trust to access the preview data plane and credentials.

## Reconciliation and rollback

`MAX_ACTIVE_PREVIEWS` defaults to 20. A failed first deployment runs teardown for
all partial per-PR resources. A failed update restores the prior task definition.
Close or unlabel abandoned PRs to run deterministic teardown. The daily scheduled
reconciler inspects services older than 72 hours and tears down only those whose
PR is closed or no longer has `preview`. It derives the PR number from the strict
`kortix-pr-N` service name. Never delete a resource without matching its PR tag
and name.

Before shared-root rollback, remove `preview` from every PR and verify zero
`kortix-pr-*` services. Restore Vercel branch variables only if their value still
targets that PR's backend. Then run and review `terraform plan -destroy`. Destroy
only this root; do not remove the shared dev VPC, preview secret, ACM certificate,
GitHub OIDC provider, state bucket, or lock table.

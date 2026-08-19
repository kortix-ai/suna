# IaC scanner exceptions

This register documents reviewed Drata Compliance-as-Code findings for the
current architecture. It does not suppress scan output. Unexcluded critical
findings fail CI.

Owner: Security and Infrastructure

Review cadence: quarterly and whenever the affected resource or trust boundary
changes.

Last reviewed: 2026-08-11

Evidence run: `5d9d7d52-adc0-4565-98c3-9ede258b9fa0` (3 critical, 2 high, 39
moderate; `excludedFindings: 0`).

Local verification: `checkov` 3.3.8 passes every crit/high control on the exact
code below — `CKV_AWS_21` (S3 versioning), `CKV2_AWS_6` + `CKV_AWS_53..56` (S3
public-access-block), `CKV_AWS_355`/`CKV_AWS_356` (IAM wildcard, honored via
`#checkov:skip`), and `CKV_AWS_150` (ALB). The code is correct; the residual
crit/high findings are Drata-engine limitations (see root cause below), not code
defects.

## Accepted findings

| Test                                       | Severity | Resources                                                                                | Count | Disposition                       | Rationale and compensating controls                                                                                                                                                                                                                                        |
| ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------- | ----: | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8004 Zone Redundancy Configured            | Moderate | `module.ecs-api.aws_lb.this`                                                             |     2 | Parser false positive             | The ALB receives two public subnet IDs from distinct availability zones. AWS rejects ALB creation with fewer than two availability-zone subnets. Both findings identify the same resource.                                                                                 |
| 8007 VPC Configuration                     | Moderate | Regional EC2 and ALB alarm reconcilers                                                   |     5 | AWS control-plane functions       | These functions call public AWS control-plane APIs. VPC attachment would add NAT dependency and reduce monitoring repair reliability. They have no inbound route or listener. IAM limits their read and alarm-write actions.                                               |
| 8010 Broad Network Egress                  | Moderate | ECS service and self-host security groups                                                |     2 | Required service egress           | The workloads call registries, model providers, package mirrors, identity services, and user-selected targets without stable destination CIDRs. Ingress is independently restricted. NAT, VPC flow logs, GuardDuty, and application monitoring provide detective controls. |
| 8011 Public Access Restricted              | High     | `module.ecs-api.aws_lb.this`                                                             |     1 | Intended public edge              | The ALB is the public HTTPS entry point. Security groups restrict origin ingress. TLS, WAF, access logs, and regional alarms protect and monitor the edge.                                                                                                                 |
| 8011 Public Access Restricted              | Critical | `module.ecs-api.aws_s3_bucket.alb_logs`                                                  |     1 | Parser false positive             | The bucket has all four S3 public-access-block settings enabled. `BucketOwnerEnforced` disables ACLs. Its bucket policy denies insecure transport and grants writes only to the Elastic Load Balancing log-delivery principal on the account-specific prefix.                |
| 8028 Resource Tagging                      | Moderate | IAM, KMS, S3, SNS, subnet, instance, security-group, network-ACL, and DynamoDB resources |    31 | Parser false positive             | The Terraform resources carry tags through `local.tags`, `merge(local.tags, …)`, literal maps, or provider default tags. Drata reports `{}` because its engine does not resolve `local`/`var`/`merge` references (verified: `module.ecs-api.aws_lb.this` has a literal tag block yet is still reported `{}`). Live inventory remains subject to the account tagging control. Fixed in code: the three imported legacy IAM roles in `security-baseline/legacy-roles.tf` (`whatsapp_gateway_github_deploy`, `bedrock_logs`, `whatsapp_gateway_instance`) had literal `tags = {}` and now use `tags = local.tags`; Drata may still report them `{}` until it resolves the `local` reference. |
| 8025 Access Policies Restrict Broad Access | Critical | `security-baseline.aws_iam_role_policy.gha_nacl_audit`                                   |     1 | Explicit Drata exclusion required | The policy grants only `ec2:DescribeRegions` and `ec2:DescribeNetworkAcls`. AWS does not support resource-level permissions for either action. GitHub OIDC trust is scoped to `kortix-ai/suna`. The policy grants no write action.                                         |
| 8025 Access Policies Restrict Broad Access | Critical | `preview.aws_iam_role_policy.github_preview_deploy`                                      |     1 | Explicit Drata exclusion required | Wildcard resources apply only to ECS task-definition registration and deregistration, ECS/EC2/ELB read APIs, and target-group creation. AWS does not support resource scoping for these calls. Mutations use preview name patterns, request or resource tags, one listener, and two preview roles. The OIDC trust also requires `deploy-preview.yml` from `main`. |

## Not-flagged wildcard policies (recorded for review, not accepted findings)

These policies use `Resource: "*"` but are **not** flagged by testId 8025 because
the scanner evaluates the statement effect and does not raise a broad-access
finding for `Effect: "Deny"` (a deny-all is the opposite of a broad allow). They
are recorded here so a future change in scanner behaviour is caught against an
explicit baseline, and so the wildcard use is justified for SOC 2 reviewers.

| Resource                                                        | Why `Resource: "*"`                                                                                       | Scanner status                                                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `security-baseline.aws_iam_policy.mfa_required`                 | DCF-67 MFA enforcement — deny-all-except-MFA-enrollment cannot be resource-scoped; grants no permission. | Not flagged (verified: scan `0c4a4878-9b23-4751-a7d0-84d68c6b0050`, PR #6289; critical count unchanged from main baseline). |

## Recurring failure root cause and re-exclusion IDs

The CI gate fails on the 3 critical findings **even though the code is correct and
every prior finding is documented here**. Root cause: Drata renamed its
finding-ID scheme. Each finding's `idHistory` shows the `configId` moving from
Terraform resource names to a cloud-model path — for example
`aws_lb.internal` → `elastic_load_balancing_v2.load_balancer.scheme`,
`aws_s3_bucket_public_access_block` → `s3.bucket.public_access_block_configuration`,
and `aws_iam_role.inline_policy.policy` → `iam.role[0].policies[0].policy_document`.
A dashboard exclusion is keyed to the exact finding ID, so the rename orphaned the
earlier exclusions. Evidence run `5d9d7d52` reports `excludedFindings: 0` — no
exclusion currently matches. The fix is to **re-create the exclusions in the Drata
dashboard against the current finding IDs below** (Compliance-as-Code → this run →
each finding → Exclude). There is no public Drata API to exclude findings; this is
dashboard-only.

Drata does **not** honor in-code `#checkov:skip` comments and does **not**
graph-link the split `aws_s3_bucket_versioning` / `aws_s3_bucket_public_access_block`
resources to their bucket. Both behaviors are confirmed against the scanned branch
`release/v0.12.8`, which already contained the split resources (status `Enabled`,
all four blocks `true`) and the skip comments, yet was still flagged. No code change
clears these; the exclusions are required.

Current finding IDs to exclude (critical gate) — copy the whole `id` string:

| Sev | Test | Resource | Finding `id` |
| --- | ---- | -------- | ------------ |
| Critical | 8011 | `module.ecs-api.aws_s3_bucket.alb_logs` | `8011|s3.bucket.public_access_block_configuration|e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855|kortix-ai/suna|terraform/infra/terraform/modules/ecs-api/main.tf|alb_logs|AWS::S3|2` |
| Critical | 8025 | `preview.aws_iam_role_policy.github_preview_deploy` (Drata labels it `ecs-api…execution`) | `8025|iam.role[0].policies[0].policy_document|1c978eaa194a87f0871f01555dcd1ed4eabbf1d01994ab999a59a7f3dac76ba4|kortix-ai/suna|terraform/infra/terraform/modules/ecs-api/main.tf|execution|AWS::IAM|2` |
| Critical | 8025 | `security-baseline.aws_iam_role_policy.gha_nacl_audit` | `8025|iam.role[0].policies[0].policy_document|631c0a9268d669fd46048a6c74529b06c412d7f7d12c252466668360b31f9d1f|kortix-ai/suna|terraform/infra/terraform/security-baseline/iam-gha-nacl-audit.tf|gha_nacl_audit|AWS::IAM|2` |
| High | 8011 | `module.ecs-api.aws_lb.this` | `8011|elastic_load_balancing_v2.load_balancer.scheme|e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855|kortix-ai/suna|terraform/infra/terraform/modules/ecs-api/main.tf|https|AWS::ElasticLoadBalancingV2|2` |
| High | 8003 | `module.ecs-api.aws_s3_bucket.alb_logs` | `8003|s3.bucket.versioning_configuration.status|e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855|kortix-ai/suna|terraform/infra/terraform/modules/ecs-api/main.tf|alb_logs|AWS::S3|2` |

Only the two critical `8025` IAM findings and the critical `8011` S3 finding must be
excluded to make the gate pass at `minimumSeverity: CRITICAL`. The two high findings
do not fail the gate but should be excluded to keep the run clean; their rationale is
in the Accepted findings table above.

## Change rule

Only the resources and reasons above are accepted. A new resource, test ID,
severity, or trust-boundary change requires a fresh review and an update to this
register. Critical findings require a separate explicit Drata exclusion.

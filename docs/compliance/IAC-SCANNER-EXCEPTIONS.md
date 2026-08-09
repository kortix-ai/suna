# IaC scanner exceptions

This register documents reviewed Drata Compliance-as-Code findings for the
current architecture. It does not suppress scan output. Unexcluded critical
findings fail CI.

Owner: Security and Infrastructure

Review cadence: quarterly and whenever the affected resource or trust boundary
changes.

Last reviewed: 2026-08-09

Evidence run: `8a1f9479-23fd-4031-8411-babcb41aec28`

## Accepted findings

| Test                                       | Severity | Resources                                                                                | Count | Disposition                       | Rationale and compensating controls                                                                                                                                                                                                                                        |
| ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------- | ----: | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8004 Zone Redundancy Configured            | Moderate | `module.ecs-api.aws_lb.this`                                                             |     2 | Parser false positive             | The ALB receives two public subnet IDs from distinct availability zones. AWS rejects ALB creation with fewer than two availability-zone subnets. Both findings identify the same resource.                                                                                 |
| 8007 VPC Configuration                     | Moderate | Regional EC2 and ALB alarm reconcilers                                                   |     5 | AWS control-plane functions       | These functions call public AWS control-plane APIs. VPC attachment would add NAT dependency and reduce monitoring repair reliability. They have no inbound route or listener. IAM limits their read and alarm-write actions.                                               |
| 8010 Broad Network Egress                  | Moderate | ECS service and self-host security groups                                                |     2 | Required service egress           | The workloads call registries, model providers, package mirrors, identity services, and user-selected targets without stable destination CIDRs. Ingress is independently restricted. NAT, VPC flow logs, GuardDuty, and application monitoring provide detective controls. |
| 8011 Public Access Restricted              | High     | `module.ecs-api.aws_lb.this`                                                             |     1 | Intended public edge              | The ALB is the public HTTPS entry point. Security groups restrict origin ingress. TLS, WAF, access logs, and regional alarms protect and monitor the edge.                                                                                                                 |
| 8028 Resource Tagging                      | Moderate | IAM, KMS, S3, SNS, subnet, instance, security-group, network-ACL, and DynamoDB resources |    24 | Parser false positive             | The Terraform resources use explicit tag maps, provider default tags, or module tag expressions. The scanner reports empty maps because it does not evaluate those expressions. Live inventory remains subject to the account tagging control.                             |
| 8025 Access Policies Restrict Broad Access | Critical | `security-baseline.aws_iam_role_policy.gha_nacl_audit`                                   |     1 | Explicit Drata exclusion required | The policy grants only `ec2:DescribeRegions` and `ec2:DescribeNetworkAcls`. AWS does not support resource-level permissions for either action. GitHub OIDC trust is scoped to `kortix-ai/suna`. The policy grants no write action.                                         |

## Not-flagged wildcard policies (recorded for review, not accepted findings)

These policies use `Resource: "*"` but are **not** flagged by testId 8025 because
the scanner evaluates the statement effect and does not raise a broad-access
finding for `Effect: "Deny"` (a deny-all is the opposite of a broad allow). They
are recorded here so a future change in scanner behaviour is caught against an
explicit baseline, and so the wildcard use is justified for SOC 2 reviewers.

| Resource                                                        | Why `Resource: "*"`                                                                                       | Scanner status                                                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `security-baseline.aws_iam_policy.mfa_required`                 | DCF-67 MFA enforcement — deny-all-except-MFA-enrollment cannot be resource-scoped; grants no permission. | Not flagged (verified: scan `0c4a4878-9b23-4751-a7d0-84d68c6b0050`, PR #6289; critical count unchanged from main baseline). |

## Change rule

Only the resources and reasons above are accepted. A new resource, test ID,
severity, or trust-boundary change requires a fresh review and an update to this
register. Critical findings require a separate explicit Drata exclusion.

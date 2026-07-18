# IaC scanner exceptions

This register documents the non-critical Drata Compliance-as-Code findings that
are accepted for the current architecture. It does not suppress scan output:
the findings remain visible in every run. Unexcluded critical findings fail CI.

Owner: Security and Infrastructure

Review cadence: quarterly and whenever the affected resource or trust boundary
changes.

Last reviewed: 2026-07-16

Evidence run: `ca3bda98-c916-4bc4-90b8-210f68a22b63`

## Accepted findings

| Test                                              | Resource                                          | Count | Disposition                                 | Rationale and compensating controls                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------- | ----: | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8004 Zone Redundancy Configured                   | `module.ecs-api.aws_lb.this`                      |     2 | Parser false positive                       | The ALB attaches `public_subnet_ids[0]` and `[1]`, which are created in distinct availability zones. AWS requires at least two AZ subnets for an ALB. The duplicate findings identify the same resource.                                                                                                                   |
| 8028 Resource Tagging                             | `module.network.aws_subnet.public` and `.private` |     2 | Parser false positive                       | Both subnet resources contain explicit inventory tag maps including `ManagedBy`, `Name`, `Environment`, `Project`, `Service`, `Platform`, and `Tier`. The scanner reports an empty map because it does not evaluate the resource's expressions.                                                                            |
| 8011 Public Access Restricted                     | `module.ecs-api.aws_lb.this`                      |     1 | Intended public edge                        | The application load balancer is the public HTTPS entry point. Origin ingress is constrained by security groups and the edge is protected by TLS, WAF, logging, and monitoring. Making the edge private would make the public service unavailable.                                                                         |
| 8011 Public Access Restricted                     | `dev-eks.aws_eks_cluster.this`                    |     1 | Approved authenticated control-plane access | GitHub-hosted deployment runners require a network path to the EKS API. The endpoint is TLS- and IAM-authenticated, private access is also enabled, access is audited, and workload nodes remain in private subnets. This exception must be revisited when a VPC-hosted deployment runner is available.                    |
| 8010 Network Configurations Restrict Broad Access | `module.ecs-api.aws_security_group.service`       |     1 | Required service egress                     | API and gateway workloads call external model providers, registries, identity services, and other SaaS endpoints without stable destination CIDRs. Ingress is limited to the ALB security group; tasks run in private subnets behind NAT; VPC flow logs, GuardDuty, and application monitoring provide detective controls. |
| 8010 Network Configurations Restrict Broad Access | `module.selfhost-ec2.aws_security_group.this`     |     1 | Required self-host egress                   | The reusable self-host host must reach package mirrors, container registries, ACME, GitHub releases, and user-selected sandbox targets. Ingress is independently restricted, SSM is the administration path, and the module documents the outbound requirement.                                                            |

## Change rule

Only the resources and reasons above are accepted. A new resource, test ID,
severity, or trust-boundary change requires a fresh review and an update to this
register. Critical findings require a separate, explicit Drata exclusion with
supporting evidence and are not accepted by this register alone.

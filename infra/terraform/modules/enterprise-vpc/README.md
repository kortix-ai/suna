# Enterprise VPC runtime plane

This module is the single-tenant AWS substrate used for Kortix-owned
customer-zero and customer VPC installations. It intentionally uses the same
EKS platform modules as Kortix Cloud while changing ownership, release channel,
data boundary, and update control plane.

## Runtime topology

- Three-AZ VPC with one NAT gateway per AZ, private workload subnets, VPC flow
  logs, default-deny default security group, and private AWS service endpoints.
- Private-only EKS control plane with three on-demand nodes, node repair,
  control-plane logging, and customer-KMS Kubernetes secret encryption.
- One private, SSM-only EC2 host for the official Supabase Docker stack, with a
  separately attached encrypted EBS data volume and EC2 system recovery.
- Customer KMS keys, Secrets Manager, immutable ECR image repositories, ACM,
  CloudTrail, encrypted logs, alerting, authenticated TUF release bundles, WAL
  bucket, hourly AWS Backup recovery points, and vault lock.
- Customer-owned EventBridge, Step Functions, and CodeBuild reconciliation. A
  Kortix event is only a wake-up hint; hourly reconciliation and TUF metadata
  are authoritative.
- Customer Route 53 owns ACM validation and the two application records.
  `external-dns` is restricted to the configured hosted-zone ID through a
  pre-created IRSA role; enterprise deployments have no Cloudflare API token.

## Safety contract

Every plan is classified by `infra/terraform/scripts/guard-enterprise-plan.ts`:

- any delete or replacement is blocked;
- IAM, KMS, EKS access, network, backup, audit, encryption, policy, versioning,
  and retention changes require manual customer review; and
- ordinary additive/runtime changes may auto-apply.

`force` may bypass a maintenance window, never signature verification, plan
classification, account pinning, or the permission boundary. The automatic
apply role cannot mutate IAM/KMS/network/release trust and explicitly denies
destructive AWS actions even if the updater process were compromised.

Customer workload, updater, EBS CSI, autoscaler, and rollout roles require
`permissions_boundary_arn`, normally the output of `modules/enterprise-state`.
The AWS EKS control-plane and node roles plus the ALB controller retain their
narrowly scoped AWS-managed/controller policies because their required network
and service-linked-role actions are explicitly forbidden by the workload
boundary. Kortix GitHub never receives customer AWS credentials. Optional
operator access is customer-approved, external-ID protected, limited to
one-hour sessions, read-only EKS access, SSM host operations, and starting a
reconcile execution.

## Release prerequisites

Do not apply this module with placeholder release values. Deployment requires:

1. an offline-reviewed TUF root digest;
2. a digest-pinned updater bootstrap binary;
3. immutable enterprise artifacts signed with KMS-backed Cosign; and
4. a certified `stable` target using `<prod-version>-e<revision>`.

The CLI generates all internal database, Supabase, API, gateway, and signing
credentials directly into customer Secrets Manager after the cluster stage.
It never persists those values in the instance config. Operator-owned values
(SMTP, Daytona, and the initial model provider) are set with
`kortix self-host env set`; first reconciliation waits until they are present.
The signed Supabase release bundle owns Compose startup, WAL archival,
checksum-verified point-in-time restore, migrations, health checks, rollback
hooks, and coordinated rotation of the updater-managed credentials. PITR and
the updater use mutually exclusive DynamoDB recovery/lease flags. Hourly EBS
recovery points are the backstop; the five-minute RPO depends on WAL archival
and a real restore drill being live and tested.

Reusable modules never retain `.terraform.lock.hcl`; generated environment
roots do, so provider selections are reviewable and reproducible.

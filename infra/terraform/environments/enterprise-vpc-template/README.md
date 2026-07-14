# Enterprise VPC generated-root template

This is the reviewed multi-stage Terraform root embedded by `kortix self-host`.
It is a template, not a desired-state repository, and never contains customer
secrets or customer-specific tfvars.

1. `state/` creates the customer-owned KMS key, versioned S3 state bucket,
   DynamoDB lock table, state access-log bucket, and mandatory permissions
   boundary. Its small bootstrap state starts locally, then the CLI migrates it
   into the new bucket and verifies lineage/serial before local cleanup.
2. `cluster/` creates the entire private AWS runtime plane via
   `modules/enterprise-vpc`: the VPC, the ECS Fargate cluster with the three
   services and one-off migrate/deployer task-defs, the shared ALB and target
   groups, the Supabase EC2, KMS/Secrets Manager/ECR/CloudTrail, AWS Backup, the
   daily deployer schedule, and the Bedrock-enabled gateway task role. The AWS
   account is pinned in both the CLI config and a Terraform precondition. The
   configured public Route 53 hosted zone must already be delegated; Terraform
   creates and waits for ACM validation records in that customer zone.
3. `platform/` runs after the cluster stage and does the one remaining
   post-cluster step under the ECS model: it reads the cluster remote state and
   aliases `api_domain` and `frontend_domain` (A + AAAA) at the shared ALB. This
   replaces what `external-dns` did under the retired EKS design; there are no
   Helm/Kubernetes/External-Secrets resources anymore.

Never run these roots manually against an unverified profile. The CLI prints the
STS identity and refuses an account mismatch before `plan` or `apply`.

The CLI injects `state.permissions_boundary_arn` into the generated cluster
variables. Placeholder TUF roots or release URLs are valid for read-only plan
tests only and must never be applied. Digest-pinned images are owned by the
deployer, not Terraform: the cluster stage seeds a placeholder image and the
first `kortix self-host deploy` rolls the real signed revisions.

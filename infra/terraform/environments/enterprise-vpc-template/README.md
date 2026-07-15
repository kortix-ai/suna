# Enterprise VPC generated-root template

This is the reviewed multi-stage Terraform root embedded by `kortix self-host`.
It is a template, not a desired-state repository, and never contains customer
secrets or customer-specific tfvars.

1. `state/` creates the customer-owned KMS key, versioned S3 state bucket,
   DynamoDB lock table, state access-log bucket, and mandatory permissions
   boundary. Its small bootstrap state starts locally, then the CLI migrates it
   into the new bucket and verifies lineage/serial before local cleanup.
2. `cluster/` creates the entire AWS runtime plane via `modules/enterprise-vpc`:
   the VPC, the single public EC2 appliance host (Caddy + the Kortix containers +
   official Supabase Docker) with its Elastic IP and Bedrock-enabled instance
   profile, the encrypted data EBS + AWS Backup, KMS/Secrets Manager/ECR mirror/
   CloudTrail, the self-healing alarms, and the application A records → the EIP.
   The AWS account is pinned in both the CLI config and a Terraform precondition.
   The configured public Route 53 hosted zone must already be delegated; the box
   also uses it for ACME DNS-01 (Caddy owns TLS — there is no ACM certificate).
3. `platform/` is retained as a no-op for backward compatibility. Under EKS it
   ran external-dns; under ECS it aliased the domains at the ALB. The appliance
   has one box with a stable EIP and the app A records live in the cluster stage,
   so no separate post-cluster stage is needed.

Never run these roots manually against an unverified profile. The CLI prints the
STS identity and refuses an account mismatch before `plan` or `apply`.

The CLI injects `state.permissions_boundary_arn` into the generated cluster
variables. Placeholder TUF roots or release URLs are valid for read-only plan
tests only and must never be applied. Terraform stands up the box and its data
plane; the on-box updater (triggered by the first `kortix self-host deploy` and
by a daily systemd timer) pulls the signed, digest-pinned release and installs
the app + Supabase bundles.

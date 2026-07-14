# Enterprise VPC generated-root template

This is the reviewed two-stage Terraform root embedded by `kortix self-host`.
It is a template, not a desired-state repository and never contains customer
secrets or customer-specific tfvars.

1. `state/` creates the customer-owned KMS key, versioned S3 state bucket,
   DynamoDB lock table, state access-log bucket, and mandatory permissions
   boundary. Its small bootstrap state starts locally, then the CLI migrates it
   into the new bucket and verifies lineage/serial before local cleanup.
2. `cluster/` creates the private AWS runtime plane. The AWS account is pinned
   in both the CLI config and Terraform precondition. The configured public
   Route 53 hosted zone must already be delegated; Terraform creates and waits
   for ACM validation records in that customer zone.
3. `platform/` runs only inside the customer VPC (CodeBuild) after private EKS
   exists. It installs the shared EKS controllers, External Secrets, Route 53
   external-dns, and the application namespace. The customer updater is the
   only Helm reconciler; enterprise environments do not install Argo CD.

Never run these roots manually against an unverified profile. The CLI prints
the STS identity and refuses an account mismatch before `plan` or `apply`.

The CLI injects `state.permissions_boundary_arn` into the generated cluster
variables. Placeholder TUF roots, bootstrap digests, or release URLs are valid
for read-only plan tests only and must never be applied.

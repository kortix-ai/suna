# Enterprise state trust plane

This module bootstraps the customer-owned trust plane before any Kortix runtime
infrastructure is created:

- a rotating customer KMS key;
- a versioned, encrypted, non-public Terraform state bucket;
- a dedicated encrypted state-access-log bucket;
- a deletion-protected DynamoDB lock table; and
- a mandatory workload permissions boundary.

The state root uses a local bootstrap state file. After apply, the management
CLI reads `backend_config`, writes a generated S3 backend configuration, and
runs `terraform init -migrate-state`. The bootstrap file is removed only after
the remote state can be pulled and its lineage/serial match the local state.

The permissions boundary grants nothing on its own. Effective role permissions
are the intersection of the boundary and each narrow identity policy. It
explicitly denies mutation of IAM/KMS trust, VPC/network boundaries, EKS access,
EventBridge publisher trust, S3 access policies, and secret resource policies.
Those controls can change only through a customer-authorized manual review.

The account precondition fails closed if the active AWS identity does not match
`expected_account_id`. State resources use `prevent_destroy`; decommissioning is
a separate reviewed procedure, never an updater action.

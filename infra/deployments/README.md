# infra/deployments

Kortix-internal live Terraform roots — actual running boxes we operate,
not the user-facing self-host distribution (that's [`self-host/`](../../self-host/)
at the repo root: a thin, one-README, bring-your-own-box template anyone can
copy). Each subdirectory here is a real instance:

- `vps-demo/` — the demo box at `ec2-vps-demo.kortix.cloud`.

`vps-demo` instantiates the shared [`infra/terraform/modules/selfhost-ec2`](../terraform/modules/selfhost-ec2)
module — same as `self-host/terraform`, just with Kortix-specific
`terraform.tfvars` already filled in and committed instead of left as
`.example`.

## State is local and gitignored — always

Every root here uses `backend "local"` (see each dir's `backend.tf`).
Terraform state (`terraform.tfstate`, `.terraform/`, `.terraform.lock.hcl`,
`*.tfvars`) lives only on whichever operator machine ran `terraform apply`
and is gitignored (see root `.gitignore`'s `infra/deployments/**` block) —
it is **never** committed. That means:

- These directories are **operator-applied**, not CI-applied. There is no
  workflow that runs `terraform apply` against them.
- If you need to run `terraform` here, you need the state file (or a fresh
  `terraform init` + a plan you're prepared to reconcile against reality) —
  ask whoever last applied it, or check the demo/deploy runbooks.
- Never run `terraform` against a root here speculatively — these are real,
  live customer/demo infrastructure.

## Retired: single-tenant customer deployments now live in their own repos

Single-tenant customer boxes provisioned from this directory have been fully
adopted into their own dedicated infra repos, each with its own S3-backed
Terraform state inside the customer's own AWS account. Those repos pin the
same [`infra/terraform/modules/selfhost-ec2`](../terraform/modules/selfhost-ec2)
module by `?ref=` tag — this monorepo has no other artifact tied to those
boxes anymore. Don't recreate a retired deployment directory here; if you
need to touch one of those boxes, do it from the customer's own infra repo.

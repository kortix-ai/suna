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

## `essentia` moved out of this monorepo entirely

Essentia's single-tenant box (`essentia.kortix.cloud`) used to be provisioned
from `deployments/essentia` at the repo root (a laptop-local, unlocked
`terraform.tfstate`). It has been fully adopted into its own repo,
[`Essentia-Innovation/kortix-infra`](https://github.com/Essentia-Innovation/kortix-infra),
with state in an S3 backend inside Essentia's own AWS account
(`327903111249`). That repo pins the same
[`infra/terraform/modules/selfhost-ec2`](../terraform/modules/selfhost-ec2)
module by `?ref=` tag — this monorepo has no other artifact tied to that box
anymore. Don't recreate `deployments/essentia` here; if you need to touch
that box, do it from `kortix-infra`.

# infra/deployments

Kortix-internal live Terraform roots — actual running boxes we operate,
not the user-facing self-host distribution (that's [`self-host/`](../../self-host/)
at the repo root: a thin, one-README, bring-your-own-box template anyone can
copy). Each subdirectory here is a real instance:

- `vps-demo/` — the demo box at `ec2-vps-demo.kortix.cloud`.
- `essentia/` — Essentia's dedicated single-tenant box (in Essentia's own AWS
  account). *Currently mid-move here from the repo-root `deployments/`
  directory — see note below.*

Both instantiate the shared [`infra/terraform/modules/selfhost-ec2`](../terraform/modules/selfhost-ec2)
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

## Note: `essentia/` move in progress

As of this consolidation (`self-host/` + `infra/deployments/` layout, see the
`refactor/generic-self-host` branch), `deployments/vps-demo` moved to
`infra/deployments/vps-demo` — done. `deployments/essentia` was **left in
place** at the repo root because it was an actively in-flight operator deploy
(uncommitted `.tf` edits, a live `terraform.tfstate.lock.info` at the time)
when this move happened, and relocating a directory out from under a running
`terraform apply` is exactly the kind of thing that corrupts local state
paths. Once that deploy settles, move it the same way:

```sh
git mv deployments/essentia infra/deployments/essentia
```

then update its `module` block's `source` from
`../../infra/terraform/modules/selfhost-ec2` to
`../../terraform/modules/selfhost-ec2` (one less `../infra` hop, since this
directory is now itself under `infra/`) — same fix already applied to
`vps-demo/main.tf`. Don't run `terraform init`/`apply` as part of that move;
the operator who owns that box does that separately, from wherever its state
file actually lives.

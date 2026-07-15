# selfhost-ec2 — a thin, optional provisioner for `kortix self-host`

**This is convenience sugar over the generic Docker self-host, not a parallel
deployment system.** Terraform provisions a single EC2 box exactly once —
instance, a durable data volume, a security group, an Elastic IP, optional
Route53 records, and daily snapshots — then cloud-init runs the *exact same*
`kortix self-host init` / `kortix self-host start` any self-host user runs by
hand (see `scripts/kortix-selfhost-up.sh` and
`docs/runbooks/self-hosting.md`). After that, the box keeps itself current via
the in-compose nightly `kortix-updater` service. **Re-running `terraform
apply` does not redeploy the app** — there is no Terraform-side update
mechanism to keep in sync with the updater, on purpose.

## What it creates

- **EC2 instance** (`t3.xlarge` by default) on Ubuntu 24.04 LTS, resolved via
  the public Canonical SSM parameter (or pin `ami_id`). IMDSv2 required, EBS
  optimized, an IAM instance profile with `AmazonSSMManagedInstanceCore`
  (connect with `aws ssm start-session`, no SSH key or open port needed).
- **A separate EBS data volume** (`data_volume_size_gb`, default 100GB, gp3,
  encrypted, `delete_on_termination = false`) holding **all** durable
  self-host state — Docker's own data-root (images, containers, the
  updater/Caddy named volumes) *and* the kortix CLI's instance directory
  (`KORTIX_SELF_HOST_CONFIG_DIR`), which is where the CLI persists Postgres
  and Supabase Storage as bind mounts. That's why this module doesn't just
  bind-mount `/var/lib/docker`: Postgres data lives under
  `<instance-dir>/volumes/db/data`, not inside Docker's volume store, so
  losing track of `KORTIX_SELF_HOST_CONFIG_DIR` would silently lose the
  database on instance replacement. See `templates/user-data.sh.tftpl`.
- **Security group**: 80 (ACME HTTP-01) + 443 in from `allowed_cidrs`
  (`0.0.0.0/0` by default — restrict it), all egress. SSH stays closed unless
  you set `ssh_ingress_cidrs` (and `key_name`).
- **Elastic IP** (stable across instance replacement) + optional **Route53 A
  records** for `var.domain` and the API hostname when `zone_id` is set;
  otherwise point your own DNS at the `public_ip` output.
- **Daily EBS snapshots** of the data volume (`aws_dlm_lifecycle_policy`,
  `snapshot_retention_days` days retained, default 7).

## What it deliberately does NOT do

- **No secrets.** `DAYTONA_API_KEY`, managed-git tokens, SMTP, etc. are not
  Terraform inputs — cloud-init runs `kortix self-host init
  --allow-missing-secrets` so the box comes up without them, and the
  `post_apply_next_steps` output tells you how to set them afterward (SSM in,
  `kortix self-host configure`, or the dashboard).
- **No ongoing reconciliation.** The in-compose `kortix-updater` (already part
  of every self-host stack) is what keeps images current on the configured
  channel — Terraform never touches the running app again after the first
  boot.
- **No custom VPC/networking stack.** Bring your own (`vpc_id` / `subnet_id`),
  or leave both empty to use the account's default VPC/subnet — this module
  is meant to be genuinely thin, not a rebuild of `modules/network`.

## Usage

See `infra/terraform/examples/selfhost-ec2` for a complete root module. Minimal:

```hcl
module "kortix_selfhost" {
  source = "../../modules/selfhost-ec2"

  domain = "kortix.example.com"
  tags   = { Project = "kortix-selfhost" }
}

output "next_steps" {
  value = module.kortix_selfhost.post_apply_next_steps
}
```

## Inputs of note

- `domain` (required) — public domain; `KORTIX_API_DOMAIN` defaults to
  `api.<domain>` (override with `api_domain`).
- `instance_type` (default `t3.xlarge`), `ami_id` / `ami_ssm_parameter`,
  `key_name` (optional — SSM works without it), `vpc_id` / `subnet_id`
  (optional — default VPC/subnet otherwise).
- `allowed_cidrs` (80/443 ingress), `ssh_ingress_cidrs` (opt-in only).
- `data_volume_size_gb` (default 100), `data_volume_kms_key_id` (optional CMK).
- `snapshot_retention_days` (default 7), `snapshot_time`.
- `zone_id` (optional Route53 zone), `api_domain`, `dns_ttl`.
- `instance_name` (the `kortix self-host --instance` name), `kortix_channel`
  (`stable`/`latest`), `kortix_version` (pin an exact tag instead),
  `auto_update` (`on`/`off`), `single_account_mode`, `admin_email`,
  `acme_email`.

## Outputs

`public_ip`, `instance_id`, `data_volume_id`, `dashboard_url`, `api_url`,
`dns_managed_by_terraform`, `ssm_connect_command`, `post_apply_next_steps`
(what to do next — secrets, dashboard, updates).

## Replacing the instance without losing data

The data volume (`aws_ebs_volume.data`) has `delete_on_termination = false`
and is attached via a separate `aws_volume_attachment` resource — destroying
or replacing `aws_instance.this` (a new AMI, instance type, etc.) does not
destroy it. On the new instance, cloud-init runs again, detects the volume
already has a filesystem (skips `mkfs`), mounts it at the same path, and
`kortix self-host init`/`start` find the existing instance directory (same
`KORTIX_SELF_HOST_CONFIG_DIR`) and reconcile against it rather than creating a
fresh one.

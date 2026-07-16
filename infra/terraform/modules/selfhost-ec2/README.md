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
  (connect with `aws ssm start-session`, no SSH key or open port needed). A
  plan-time precondition rejects an `instance_type`/AMI architecture mismatch
  (e.g. a Graviton `instance_type` against the default amd64 AMI) with a
  clear error instead of failing to boot — see "Instance type / AMI
  architecture" below.
- **A separate EBS data volume** (`data_volume_size_gb`, default 100GB, gp3,
  encrypted, `delete_on_termination = false`, `lifecycle.prevent_destroy =
  true`) holding **all** durable self-host state — Docker's own data-root
  (images, containers, the updater/Caddy named volumes), **containerd's own
  root** (the actual image/container filesystem layers — see "Disk layout"
  below), *and* the kortix CLI's instance directory
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
  records** for `var.domain` and the API hostname when `zone_id` is set
  (`allow_overwrite = true`, so this cleanly takes over a zone that already
  has an A record under these names — e.g. replacing a hand-deployed box);
  otherwise point your own DNS at the `public_ip` output.
- **EBS snapshots** of the data volume (`aws_dlm_lifecycle_policy`) on a
  configurable schedule — `backup_interval_hours` (default 24, i.e. once
  daily; any of DLM's supported intervals — 1, 2, 3, 4, 6, 8, 12, 24 — work,
  e.g. `6` for four snapshots a day) and `backup_retention_count` (default 7 —
  stores up to this many backups before the oldest is pruned). See "Restoring
  from a snapshot" below for the restore procedure (there is no automated
  restore — this only creates the snapshots).
- **CloudWatch monitoring** (`var.enable_alarms`, default on): an EC2
  status-check alarm plus disk-usage (root and data volume) and memory-usage
  alarms fed by the CloudWatch agent that bootstrap installs and configures,
  notifying an SNS topic (`var.alarm_sns_topic_arn` to reuse an existing one,
  or the module creates its own, optionally with `var.alarm_email`
  subscribed). See "Monitoring" below.

## What it deliberately does NOT do

- **No secrets.** `DAYTONA_API_KEY`, managed-git tokens, SMTP, etc. are not
  Terraform inputs — cloud-init runs `kortix self-host init` so the box comes
  up without them (it warns rather than refusing), and the
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
- `availability_zone` — optional override for the data volume's AZ. Leave
  empty (default) to derive it from the subnet, which is almost always
  correct; see "Replacing the instance without losing data" for why this is
  never derived from the instance itself.
- `allowed_cidrs` (80/443 ingress), `ssh_ingress_cidrs` (opt-in only).
- `data_volume_size_gb` (default 100), `data_volume_kms_key_id` (optional CMK).
- `backup_interval_hours` (default 24 — 1/2/3/4/6/8/12/24 are the valid DLM
  intervals), `backup_retention_count` (default 7), `snapshot_time` (only
  used when `backup_interval_hours = 24`).
- `zone_id` (optional Route53 zone), `api_domain`, `dns_ttl`.
- `instance_name` (the `kortix self-host --instance` name), `kortix_channel`
  (`stable`/`latest`), `kortix_version` (pin an exact tag instead),
  `auto_update` (`on`/`off`), `admin_email`, `acme_email`.
- `kortix_cli_install_url` (the CLI installer URL) and `kortix_cli_channel`
  (`prod`/`dev` — which CLI build the installer fetches; use `dev` if the
  published `prod` CLI hasn't caught up yet to flags this module passes to
  `kortix self-host init`).
- `enable_alarms` (default `true`), `alarm_sns_topic_arn` (reuse an existing
  topic instead of the module creating one), `alarm_email` (subscribe an
  address to the module-created topic), `disk_usage_alarm_threshold_percent`
  (default 85), `memory_usage_alarm_threshold_percent` (default 90),
  `alarm_evaluation_periods` (default 3 × 5-minute periods).

## Outputs

`public_ip`, `instance_id`, `data_volume_id`, `dashboard_url`, `api_url`,
`dns_managed_by_terraform`, `ssm_connect_command`, `alarm_sns_topic_arn`,
`post_apply_next_steps` (what to do next — secrets, dashboard, updates).

## Replacing the instance without losing data

The data volume (`aws_ebs_volume.data`) has `delete_on_termination = false`,
`lifecycle.prevent_destroy = true`, and is attached via a separate
`aws_volume_attachment` resource — destroying or replacing `aws_instance.this`
(a new AMI, instance type, etc.) does not destroy it. On the new instance,
cloud-init runs again, detects the volume already has a filesystem (skips
`mkfs`), mounts it at the same path, and `kortix self-host init`/`start` find
the existing instance directory (same `KORTIX_SELF_HOST_CONFIG_DIR`) and
reconcile against it rather than creating a fresh one.

**The AZ pin is the load-bearing detail here, and it bit us once — fixed
2026-07-16.** `availability_zone` is a `ForceNew` attribute on
`aws_ebs_volume`: if the volume's AZ ever depends on `aws_instance.this`'s own
(post-apply-known) `availability_zone` attribute, then replacing the instance
makes that value "known after apply" for the volume too — which Terraform can
only satisfy by **destroying and recreating the volume**, silently taking the
database with it. A live `terraform plan -replace=aws_instance.this` repro
against the pre-fix code confirmed exactly this (`aws_ebs_volume.data` showed
`delete` + `create`); the same repro against the fixed code shows `no-op`
(`local.availability_zone` — see `main.tf`/`storage.tf` — is derived from the
subnet via `data.aws_subnet.selected`, never from the instance). Belt and
suspenders: `lifecycle.prevent_destroy = true` on the volume refuses *any*
destroy/replace of it outright, regardless of cause — to retire a box's data
on purpose, remove that block in its own reviewed apply first.

**Guard this doesn't regress**: `scripts/check-data-volume-safe.sh
<plan-file>` takes a saved `terraform plan -out=...` and fails loudly if
`aws_ebs_volume.data` would be replaced or deleted. Wire it into CI for any
root module that consumes this one, e.g.:

```sh
terraform plan -out=tf.plan
../../terraform/modules/selfhost-ec2/scripts/check-data-volume-safe.sh tf.plan
```

## Disk layout: containerd lives on the data volume too

**Root-caused live — fixed 2026-07-16.** Setting Docker's `data-root` in
`/etc/docker/daemon.json` moves *dockerd's* state (images/containers
metadata, named volumes), but with the modern containerd-snapshotter setup
the actual image/container filesystem **layers** live under containerd's own
`root` (`/var/lib/containerd` by default) — a separate systemd-managed daemon
docker delegates to, not something `daemon.json` touches. Both live boxes had
14-16GB under `/var/lib/containerd` on their 30GB root volumes (59-65% full)
while the 100GB data volume sat almost empty, because only dockerd's
data-root had been relocated.

Fixed for **new** boxes: `templates/user-data.sh.tftpl` now also writes
`/etc/containerd/config.toml` with `root = "<data_mount_path>/containerd"`
*before* containerd's first start (containerd starts as its own systemd unit
the moment the `containerd.io` package installs, so the daemon is stopped
immediately after install and restarted only after the config is repointed).
`daemon.json` also now sets default log rotation
(`log-driver: json-file`, `max-size: 10m`, `max-file: 3`) so no single
container's logs can fill the root volume either.

**Existing boxes are NOT migrated automatically** — this only applies to a
fresh install. To move an already-running box's containerd state onto the
data volume, an ops agent should do this deliberately (expect a brief outage
while containerd is stopped):

1. `sudo systemctl stop kortix-selfhost-bootstrap.service` (see "Bootstrap
   resilience" below) so nothing restarts the stack mid-migration, then
   `cd $(kortix self-host config-dir)/<instance> && docker compose stop` (or
   just accept the containers stop when containerd does in the next step).
2. `sudo systemctl stop docker.service containerd.service`.
3. `sudo mkdir -p /mnt/kortix-data/containerd && sudo rsync -aHAX --info=progress2 /var/lib/containerd/ /mnt/kortix-data/containerd/`
   (rsync, not `mv`/`cp`, to preserve hardlinks/xattrs the overlay snapshotter
   relies on).
4. Edit `/etc/containerd/config.toml`: set `root =
   "/mnt/kortix-data/containerd"` (add `version = 2` if the file doesn't
   already set it).
5. `sudo mv /var/lib/containerd /var/lib/containerd.bak-$(date +%s)` (keep the
   backup until you've confirmed containers come back healthy, then delete
   it to reclaim root-volume space — the whole point of this migration).
6. `sudo systemctl start containerd.service docker.service`, confirm `docker
   ps` shows the expected containers, then `sudo systemctl start
   kortix-selfhost-bootstrap.service` (or `docker compose up -d` directly)
   and verify the dashboard/API respond.
7. Confirm `df -h /` has real headroom back, then remove the
   `.bak-*` directory from step 5.

## Bootstrap resilience: a retried, reboot-surviving systemd unit

**Confirmed live on both boxes — fixed 2026-07-16.** cloud-init has no retry
of its own: the previous version of `templates/user-data.sh.tftpl` ran
`kortix self-host init`/`start` inline, and on both live boxes the first
`docker compose up` attempt hit a slow-cold-start dependency race
(`kortix-api` didn't report healthy before compose's dependency wait gave up)
— which made cloud-init itself report `status: error` **permanently**, even
though `kortix self-host start` run a second time (by hand) succeeded
immediately. Both boxes are only up today because someone finished the setup
manually after the fact.

Fixed by splitting responsibilities: `templates/user-data.sh.tftpl` (running
once, via cloud-init) now *only* installs prerequisites — mounts the data
volume, installs/configures Docker + containerd, installs the kortix CLI, and
(if `enable_alarms`) the CloudWatch agent — then writes and enables
`kortix-selfhost-bootstrap.service`, a systemd oneshot unit
(`Restart=on-failure`, `RestartSec=30`, a bounded 20-attempts/hour budget so a
genuinely broken box doesn't crash-loop forever) that runs the actual
`kortix self-host init`/`env set`/`start` sequence. Cloud-init hands off to it
with `systemctl start --no-block` and returns immediately — cloud-init's own
success/failure status is no longer coupled to whether the app's first-boot
health check race resolves on the first try. Because `init`/`start` are
idempotent, systemd retrying the whole unit (rather than something bespoke
inside the script) is sufficient to self-heal, and because the unit is
`enable`d (`WantedBy=multi-user.target`), **a reboot reruns it fresh** with a
new retry budget too — so even a box that exhausts one boot's budget picks
back up on the next reboot without operator intervention.

Check on a box: `systemctl status kortix-selfhost-bootstrap.service`,
`journalctl -u kortix-selfhost-bootstrap.service`.

## Monitoring

`var.enable_alarms` (default `true`) wires up the CloudWatch agent (installed
and configured by `templates/user-data.sh.tftpl` — namespace `KortixSelfHost`,
disk `used_percent` on `/` and the data mount, `mem_used_percent`) and three
alarms: EC2 status-check failure, disk usage on either volume above
`disk_usage_alarm_threshold_percent` (default 85%), and memory usage above
`memory_usage_alarm_threshold_percent` (default 90%) — each sustained for
`alarm_evaluation_periods` (default 3) consecutive 5-minute periods to absorb
short spikes (a build, a backup). All three notify `alarm_sns_topic_arn`: an
existing topic if you pass `var.alarm_sns_topic_arn`, otherwise a topic this
module creates (optionally subscribing `var.alarm_email`). Kept deliberately
minimal — this is one box, not a fleet; add more if you need them.

## Restoring from a snapshot

There is no automated restore — DLM only takes the snapshots
(`aws_dlm_lifecycle_policy.data`, tag-matched via `Backup =
"<name>-data"`/`SnapshotOf = "<name>-data"`). To restore:

1. **Locate the snapshot**: `aws ec2 describe-snapshots --owner-ids self
   --filters "Name=tag:SnapshotOf,Values=<name>-data" --query
   "reverse(sort_by(Snapshots,&StartTime))[:5]"` — pick the one you want.
2. **Create a new volume from it, in the SAME AZ as the running instance**
   (this matters — a volume can only attach to an instance in its own AZ; see
   the `availability_zone` output/`aws_instance.this.availability_zone`):
   `aws ec2 create-volume --availability-zone <az> --snapshot-id <snap-id>
   --volume-type gp3`.
3. **Swap the attachment**: stop the box (`kortix self-host stop` or
   `docker compose down` first, so nothing is mid-write), detach the current
   data volume (`aws ec2 detach-volume --volume-id <current-vol>`), attach the
   restored one at the same device name the module uses (`/dev/sdf` — or
   wherever it actually landed; Nitro instances expose it as an NVMe device,
   see `templates/user-data.sh.tftpl`'s device-probing loop), mount it at
   `/mnt/kortix-data`, then `docker compose up -d` (or `kortix self-host
   start`) again. If this is a genuinely different EBS volume ID than
   Terraform's state has recorded, follow up with `terraform apply` (or
   `terraform state rm` + re-`import`) so Terraform's state matches reality —
   otherwise the next `apply` will try to "fix" the attachment back to the
   volume ID it remembers.
4. **Boot order caveat**: the box's own boot ordering (mount →
   containerd/docker → `kortix-selfhost-bootstrap.service`) assumes the data
   volume is already attached and formatted by the time it runs — attach and
   mount the restored volume *before* rebooting/restarting the stack, not
   after, or the bootstrap unit's mount-detection loop will just find the
   already-mounted (restored) volume and proceed, which is fine, but a stale
   `/etc/fstab` UUID line pointing at the *old* volume's UUID will fail to
   mount on a subsequent reboot — update `/etc/fstab`'s UUID to the restored
   volume's (`blkid` it first) as part of the swap.
5. **Postgres crash-consistency, honestly**: EBS snapshots are
   crash-consistent for the volume as a block device, but Postgres's own data
   directory (a bind mount under the CLI's instance directory on this same
   volume) was almost certainly mid-write when the snapshot fired — this is
   equivalent to a hard power-cut from Postgres's point of view. Postgres's
   WAL-based crash recovery handles this correctly (it replays WAL to reach a
   consistent state on next start; you have not lost committed transactions
   as of the snapshot's actual instant, only in-flight ones), but expect a
   delayed startup on first boot after restore while WAL replay runs, and
   treat it as "consistent as of an unclean shutdown," not "consistent as of
   a clean `pg_dump`." If you need a guaranteed-clean restore point instead,
   run `docker compose exec supabase-db psql -c "SELECT
   pg_backup_start('manual pre-snapshot');"` immediately before triggering a
   manual snapshot and `pg_backup_stop()` after (DLM's own schedule has no
   pre/post-script hook for this on Linux — VSS pre/post scripts are a
   Windows-only DLM feature — so this only applies to manual, ad hoc
   snapshots taken outside the DLM schedule).

## State

`infra/deployments/vps-demo` uses a local, unlocked `terraform.tfstate` on
purpose (single demo box, single operator — see that directory's
`backend.tf`). That's an accepted tradeoff for exactly that use case, not a
recommendation: two concurrent `apply`s from different checkouts can race and
corrupt local state, and the only copy of it lives on whoever last ran
`apply`. If a root module using this module becomes a team-shared
environment, move to an S3 + DynamoDB-lock backend (the standard one used by
`infra/terraform/environments/*`) — see the commented example in
`infra/deployments/vps-demo/backend.tf`.

## Instance type / AMI architecture

`ami_ssm_parameter` defaults to Canonical's **amd64** Ubuntu 24.04 AMI. A
plan-time `precondition` on `aws_instance.this` (via a `data.aws_ami` lookup
on whatever AMI actually resolves) checks that against `instance_type`'s
family: a Graviton (`*g`/`a1`) `instance_type` against an `x86_64` AMI (or
vice versa — an intentionally-set arm64 `ami_id` against a non-Graviton
`instance_type`) fails at `terraform plan` with a clear message, instead of
launching an instance that fails to boot (kernel/arch mismatch). If you
intentionally want Graviton, set both `instance_type` (e.g. `t4g.xlarge`) and
an arm64 `ami_id`/`ami_ssm_parameter` together.

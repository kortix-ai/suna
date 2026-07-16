# Kortix Self-Host

Run your own private instance of Kortix — the full stack (frontend, API, LLM
gateway, and the official Supabase distribution) as one Docker Compose
project, on any box you control. Agent sessions still run on a cloud sandbox
provider (Daytona, E2B, or Platinum) — sandboxes are managed compute, not part
of this box.

This is the whole self-contained distribution: a Terraform module for
provisioning an AWS/EC2 box declaratively, plus this README. For the full
day-to-day operator reference (troubleshooting, every CLI flag, backup/restore
mechanics, the auto-updater's internals) see
[`docs/runbooks/self-hosting.md`](../docs/runbooks/self-hosting.md) in the
main Kortix repo — this page is intentionally the tight version.

## 1. Any VPS — quickstart

**Prerequisites:** a VPS (2 vCPU / 4GB RAM floor; 4 vCPU / 16GB+ recommended
for real use) running Linux, and a domain you control.

1. **Point DNS at the box.** Create an A/AAAA record for your domain (and its
   API subdomain, `api.<domain>` by default) pointing at the box's public IP.
   Ports **80** and **443** must be reachable from the internet — the bundled
   Caddy reverse proxy uses ACME HTTP-01 to issue a TLS cert automatically.

2. **Run the bootstrap command** on the box (as root, or a user with sudo):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/kortix-selfhost-up.sh \
     | bash -s -- --domain kortix.example.com --email ops@example.com
   ```

   This is [`scripts/kortix-selfhost-up.sh`](../scripts/kortix-selfhost-up.sh)
   in the main repo: it installs Docker if missing, installs the `kortix` CLI
   (the one-click installer at `kortix.com/install`), and drives the same
   `init`/`start` flow described below. Re-running it is safe — every step is
   idempotent.

   Or drive it by hand once the CLI is installed:

   ```sh
   curl -fsSL https://kortix.com/install | bash
   kortix self-host init --domain app.example.com
   ```

   `init` is a short guided flow (skippable non-interactively with flags or
   `--yes` for the defaults) that asks, in order:

   1. **Reachability** — confirms the domain/DNS above (or `--tunnel
      cloudflare` if you have no public domain — for local machines /
      evaluation only; see the runbook for the tradeoffs).
   2. **Admin email** — which account gets platform-admin on first sign-up.
   3. **Deployment shape** — whether you hold an Enterprise license (SSO/SCIM/RBAC/audit).
   4. **Sandbox provider** — `daytona` (default), `e2b`, or `platinum`, plus
      its API key.
   5. **Pipedream** (optional) — the 3,000+ app connector catalog; skip or
      configure its OAuth app credentials.
   6. **Update policy** — auto-update on/off, channel (`stable`/`latest`), and
      the daily update window.

3. **Start the stack:**

   ```sh
   kortix self-host start
   ```

   This pulls images and brings the stack up. `kortix self-host status` /
   `logs` / `doctor` are your friends while it comes up.

4. **Finish in the dashboard.** Open `https://app.example.com` and sign up
   with the admin email from step 2, then:
   - **Settings → Git** — connect a GitHub App (or PAT) so the platform can
     create project repos. This one dashboard flow replaces the old
     env-var-only managed-git setup.
   - **Settings → Model** — connect your own model key (BYOK: Anthropic,
     OpenAI, OpenRouter, etc.).

That's a complete, working instance. From here on, use the main `kortix` CLI
against it like you would against Kortix Cloud:

```sh
kortix hosts use selfhost   # already registered + pointed at your instance by `init`/`start`
kortix login
kortix whoami
kortix projects ls
cd your-project && kortix ship
```

See
[`docs/runbooks/self-hosting.md`](../docs/runbooks/self-hosting.md) for the
no-public-domain Cloudflare-tunnel evaluation path, SMTP, using the CLI
from a different machine than the one you self-hosted on, uninstalling, and
the full `kortix self-host` command reference.

## 2. Want something more robust on AWS? There's a Terraform for that

The quickstart above is the whole product — this is the same thing, provisioned
declaratively on EC2 instead of by hand, and it adds two things a hand-run box
doesn't have out of the box:

- **Automatic backups** — EBS snapshots of the data volume (Postgres, Supabase
  Storage, everything durable), on a schedule, keeping the last N.
- **Automatic daily zero-downtime updates** — already true of any self-host
  install (the in-compose updater), but Terraform sets the policy for you at
  provision time.

Use [`terraform/`](terraform/) — a thin root module that instantiates
`selfhost-ec2` (EC2 instance, a durable encrypted EBS data volume, a security
group, an Elastic IP, optional Route53 records). It provisions the box
**once**; after that, cloud-init runs the *exact same* `kortix self-host init`
/ `start` described above, and Terraform never redeploys the running app.

```sh
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill in domain, admin_email, ...
terraform init
terraform apply
```

Minimal `terraform.tfvars`:

```hcl
aws_region      = "us-east-1"
domain          = "kortix.example.com"
admin_email     = "admin@example.com"
route53_zone_id = "Z0123456789ABCDEFGHIJ"   # optional — see "Domain / DNS" below
```

See `terraform/variables.tf` for the full input surface (instance type,
network, backup schedule, update channel, ...).

### Domain / DNS — both ways are supported

The domain **must** end up resolving to the box's Elastic IP — that's not
optional (ACME can't issue a cert otherwise, and agent sandboxes need a real
public `KORTIX_URL`). Two ways to get there, either is fine:

1. **Terraform manages it** — set `route53_zone_id` to your domain's Route53
   hosted zone ID. `apply` creates the `A` records for `domain` and its API
   subdomain (`api.<domain>` by default) pointing at the new Elastic IP.
   Nothing else to do.
2. **You manage it** — leave `route53_zone_id` unset. `apply`'s
   `post_apply_next_steps` output prints the box's Elastic IP and the *exact*
   two `A` records to create with whatever DNS provider you use. Create them
   before the box finishes booting (ACME retries, but won't succeed until DNS
   resolves).

Either way, **check `terraform apply`'s final output** — it tells you which of
the two applies and, in case 2, spells out precisely what to create.

### Automatic backups

The data volume is snapshotted via AWS DLM (Data Lifecycle Manager) on a
schedule, configurable in `terraform.tfvars`:

```hcl
backup_interval_hours  = 24   # 1, 2, 3, 4, 6, 8, 12, or 24 — AWS DLM's supported intervals
backup_retention_count = 7    # stores up to this many backups before the oldest is pruned
```

Defaults to once daily, 7 retained — that's the recommended setting; stability
over frequency. The interval is configurable if you need something tighter
(e.g. `backup_interval_hours = 6` for four snapshots a day), but daily is what
we run ourselves. Snapshots are tagged and discoverable via
`aws dlm get-lifecycle-policies` / `aws ec2 describe-snapshots --filters
Name=tag:SnapshotOf,Values=<name>-data`.

### Automatic daily zero-downtime updates

Every instance runs an in-compose `kortix-updater` service — not a Terraform
concern — that checks for new images on the configured channel and, when one's
found, pulls it, runs any new database migrations, and rolls the stack forward
with zero downtime (`docker compose up -d --wait`). This is **on by default**
(`auto_update = "on"`); the time/timezone for the daily check comes from the
guided `init` flow (`kortix self-host configure` to change it later) —
Terraform only sets the initial channel/on-off policy, not the clock.

## 3. Day-2 operations

All of these run on the box itself (SSH, or `aws ssm start-session --target
<instance-id>` — the Terraform output `ssm_connect_command` gives you the
exact command, no SSH key or open port required):

```sh
kortix self-host update            # pull the newest image on your channel now, migrate, roll forward
kortix self-host env ls            # list every value, grouped by service (secrets masked)
kortix self-host env set KEY=VALUE ...   # set a value (sandbox key, GitHub token, SMTP, ...); restarts affected services only
kortix self-host env rotate KEY    # regenerate a rotatable generated secret (or --all-generated)
kortix self-host logs [service]    # tail Compose logs
kortix self-host status            # container status
kortix self-host uninstall         # stop + permanently delete this instance's data and config
```

**Restoring from a snapshot** (disaster recovery / cloning an instance):

1. Find the snapshot: `aws ec2 describe-snapshots --filters
   Name=tag:SnapshotOf,Values=<name>-data --query
   'Snapshots|sort_by(@,&StartTime)[-1]'`.
2. Create a new volume from it in the same AZ as the target instance:
   `aws ec2 create-volume --snapshot-id <snap-id> --availability-zone <az>`.
3. Stop the instance, detach the current data volume, attach the restored one
   at the same device (`/dev/sdf`), start the instance — cloud-init already
   handles "volume has an existing filesystem" on boot, so it mounts as-is and
   `kortix self-host` reconciles against the restored state.
4. `kortix self-host start` to bring the stack back up.

Full detail (whole-directory `tar` backups, logical `pg_dump` backups, and
every troubleshooting scenario) lives in
[`docs/runbooks/self-hosting.md`](../docs/runbooks/self-hosting.md).

## 4. Run a specific version or your own build

```sh
kortix self-host init --channel latest             # track the bleeding-edge moving tag instead of stable
kortix self-host init --version 0.10.1             # pin an exact released version
kortix self-host init --version dev-a1b2c3d         # pin a published dev build (e.g. from a branch's CI)
```

Testing a locally-built image (never pushed to any registry):

```sh
docker build -t kortix/kortix-api:mytest apps/api
kortix self-host init --version mytest --local-images
kortix self-host start
```

`--local-images` skips `docker compose pull` (a locally-built tag isn't on
any registry, so a blanket pull would fail) and forces auto-update off — a
box running an unpublished build must never let the nightly updater try to
pull it from nowhere.

# Separate EBS data volume holding ALL durable self-host state, so it survives
# an instance replacement untouched. cloud-init (templates/user-data.sh.tftpl)
# formats it once (if empty), mounts it at var.data_mount_path, points
# Docker's own data-root at it (images, containers, the updater/Caddy named
# volumes), AND points the kortix CLI's KORTIX_SELF_HOST_CONFIG_DIR at it —
# the latter matters because the CLI persists Postgres and Supabase Storage as
# bind mounts under its instance directory
# (<config-dir>/<instance>/volumes/db/data, .../volumes/storage), NOT as
# Docker named volumes, so mounting /var/lib/docker alone would silently lose
# the database on instance replacement.

locals {
  # Requested attach point. On Nitro-based instance types (t3, m5, ...) the
  # kernel exposes this as an NVMe device instead — user-data resolves the
  # actual block device at boot rather than hardcoding a path.
  data_volume_device_name = "/dev/sdf"

  # Where the data volume is mounted on the box. Docker's data-root lives at
  # "<data_mount_path>/docker"; the kortix CLI's KORTIX_SELF_HOST_CONFIG_DIR at
  # "<data_mount_path>/kortix-self-host".
  data_mount_path = "/mnt/kortix-data"
}

#checkov:skip=CKV2_AWS_9:backups are handled by the aws_dlm_lifecycle_policy in this module (daily snapshots, retention-capped) — an AWS Backup plan would duplicate it
resource "aws_ebs_volume" "data" {
  availability_zone = aws_instance.this.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true
  kms_key_id        = var.data_volume_kms_key_id != "" ? var.data_volume_kms_key_id : null

  tags = merge(local.tags, {
    Name   = "${local.name}-data"
    Backup = "${local.name}-data"
  })
}

resource "aws_volume_attachment" "data" {
  device_name = local.data_volume_device_name
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.this.id

  # The volume outlives the instance: replacing the instance (AMI change,
  # etc.) must never detach-and-destroy the data. Re-attach is manual (or via
  # a follow-up apply) when swapping instances.
  stop_instance_before_detaching = true
}

# ── Daily snapshots (the backup story) ─────────────────────────────────────
data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${local.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "data" {
  # DLM's description field only allows [0-9A-Za-z _-]+ — no colons,
  # parens, commas, or slashes.
  description        = "${local.name} data volume snapshots every ${var.backup_interval_hours}h retain ${var.backup_retention_count}"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      Backup = "${local.name}-data"
    }

    schedule {
      name = "kortix-backup"

      create_rule {
        interval = var.backup_interval_hours
        # DLM only fires create_rule.times for interval=24 (once-daily)
        # schedules; for sub-daily intervals the first run is undefined and
        # DLM just runs every N hours from when the policy was created — so
        # `times` is only meaningful (and only passed) in the 24h case.
        interval_unit = "HOURS"
        times         = var.backup_interval_hours == 24 ? [var.snapshot_time] : null
      }

      retain_rule {
        count = var.backup_retention_count
      }

      tags_to_add = {
        SnapshotOf = "${local.name}-data"
      }

      copy_tags = true
    }
  }

  tags = local.tags
}

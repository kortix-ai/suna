# ── Required ───────────────────────────────────────────────────────────────

variable "domain" {
  description = "Public domain to run Kortix self-host on (e.g. kortix.example.com). Passed straight through to `kortix self-host init --domain`; the API domain defaults to api.<domain> (the CLI's own default — see var.api_domain to override)."
  type        = string

  validation {
    condition     = length(trimspace(var.domain)) > 0 && !can(regex("^https?://", var.domain))
    error_message = "domain is required and must be a bare hostname (no https:// prefix), e.g. kortix.example.com."
  }
}

# ── Naming / tags ──────────────────────────────────────────────────────────

variable "name" {
  description = "Name prefix for all AWS resources (e.g. kortix-selfhost)."
  type        = string
  default     = "kortix-selfhost"
}

variable "tags" {
  description = "Extra tags applied to every resource this module creates."
  type        = map(string)
  default     = {}
}

# ── Instance ───────────────────────────────────────────────────────────────

variable "instance_type" {
  description = "EC2 instance type. t3.xlarge (4 vCPU / 16GB) is a reasonable floor for the full stack (Supabase + API + gateway + frontend + sandboxed builds)."
  type        = string
  default     = "t3.xlarge"
}

variable "ami_id" {
  description = "AMI to launch. Leave empty to resolve the latest Ubuntu 24.04 LTS AMI via the public SSM parameter (var.ami_ssm_parameter)."
  type        = string
  default     = ""
}

variable "ami_ssm_parameter" {
  description = "SSM public parameter used to resolve the AMI when var.ami_id is empty. Default tracks Canonical's official Ubuntu 24.04 LTS amd64 AMI."
  type        = string
  default     = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

variable "root_volume_size_gb" {
  description = "Root (OS) EBS volume size. Docker data lives on the separate data volume, not here — this only needs to hold the OS + kortix CLI."
  type        = number
  default     = 30
}

variable "key_name" {
  description = "Optional EC2 key pair name for SSH. Leave empty to rely on SSM Session Manager only (recommended — no open SSH port needed)."
  type        = string
  default     = ""
}

# ── Networking ─────────────────────────────────────────────────────────────

variable "vpc_id" {
  description = "VPC to launch into. Leave empty to use the account/region's default VPC."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Subnet to launch into (must be public / route to an Internet Gateway so the Elastic IP works). Leave empty to use a default subnet in the default VPC."
  type        = string
  default     = ""
}

variable "allowed_cidrs" {
  description = "CIDRs allowed to reach the box on 80 (ACME HTTP-01) and 443 (the app). Restrict this once you know your users' egress ranges."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_ingress_cidrs" {
  description = "CIDRs allowed to reach port 22. Empty (default) opens no SSH ingress at all — use `aws ssm start-session` instead (see output ssm_connect_command). Only meaningful alongside var.key_name."
  type        = list(string)
  default     = []
}

# ── Data volume (all Docker volumes, incl. Postgres, live here) ────────────

variable "data_volume_size_gb" {
  description = "Size of the separate EBS data volume that holds all durable self-host state: Docker's own data-root (images, containers, the updater/Caddy named volumes) AND the kortix CLI's instance directory (.env, compose file, and — critically — Postgres and Supabase Storage, which the CLI persists as bind mounts under its instance directory, not as Docker named volumes). Sizing this is really about your database + object storage growth, not the OS."
  type        = number
  default     = 100
}

variable "data_volume_kms_key_id" {
  description = "Optional customer-managed KMS key ARN for the data volume. Leave empty to use the account's default aws/ebs key (the volume is always encrypted either way)."
  type        = string
  default     = ""
}

# ── Backups: DLM snapshot schedule for the data volume ─────────────────────

variable "backup_interval_hours" {
  description = "How often to snapshot the data volume (DLM lifecycle policy), in hours. Must be one of the interval values AWS DLM supports: 1, 2, 3, 4, 6, 8, 12, or 24. Default 24 (once daily); set e.g. 6 for four snapshots a day."
  type        = number
  default     = 24

  validation {
    condition     = contains([1, 2, 3, 4, 6, 8, 12, 24], var.backup_interval_hours)
    error_message = "backup_interval_hours must be one of the DLM-supported interval values: 1, 2, 3, 4, 6, 8, 12, 24."
  }
}

variable "backup_retention_count" {
  description = "How many snapshots of the data volume to keep (DLM retain_rule.count) — stores up to this many backups before the oldest is pruned. Default 7."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_count >= 1 && var.backup_retention_count <= 1000
    error_message = "backup_retention_count must be between 1 and 1000 (DLM's own retain_rule.count limit)."
  }
}

variable "snapshot_time" {
  description = "UTC time-of-day (HH:MM) the data-volume snapshot runs. Only meaningful when backup_interval_hours = 24 — DLM only accepts a fixed start time for once-daily schedules; sub-daily intervals run every N hours from policy creation instead."
  type        = string
  default     = "03:00"
}

# ── DNS (optional — Route53) ────────────────────────────────────────────────

variable "zone_id" {
  description = "Route53 hosted zone ID to create records in. Leave empty to skip DNS entirely and point your own DNS at the eip_public_ip output instead."
  type        = string
  default     = ""
}

variable "api_domain" {
  description = "API hostname to point at this box. Leave empty to default to api.<var.domain> (matches the kortix CLI's own default, so you normally don't need to set this)."
  type        = string
  default     = ""
}

variable "dns_ttl" {
  description = "TTL (seconds) for the Route53 A records, when created."
  type        = number
  default     = 300
}

# ── kortix self-host bootstrap (see user-data) ──────────────────────────────

variable "instance_name" {
  description = "The kortix self-host `--instance` name (lets one box run multiple isolated stacks; almost always leave at the default)."
  type        = string
  default     = "default"
}

variable "kortix_channel" {
  description = "Image channel the stack tracks (`stable` or `latest`) — passed to `kortix self-host init --channel`. Ongoing updates are applied by the in-compose auto-updater, not by re-running Terraform."
  type        = string
  default     = "stable"

  validation {
    condition     = contains(["stable", "latest"], var.kortix_channel)
    error_message = "kortix_channel must be \"stable\" or \"latest\"."
  }
}

variable "kortix_version" {
  description = "Optional exact version/tag to pin instead of tracking a channel (passed as `kortix self-host init --tag`). Leave empty to track var.kortix_channel."
  type        = string
  default     = ""
}

variable "kortix_cli_install_url" {
  description = "URL for the one-click kortix CLI installer (the canonical published path)."
  type        = string
  default     = "https://kortix.com/install"
}

variable "kortix_cli_channel" {
  description = "Which CLI build the installer fetches: `prod` (default — latest tagged vX.Y.Z GitHub Release) or `dev` (the continuously-rebuilt `dev-latest` prerelease, tracking `main`). The published `prod` CLI can lag newly merged self-host flags/behavior (e.g. right after a feature merges to main but before the next version is cut) — set this to `dev` if `var.kortix_version`/other flags this module passes to `kortix self-host init` aren't recognized by the current prod CLI yet. Passed as `KORTIX_CHANNEL` to the installer, not to the app itself."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "dev"], var.kortix_cli_channel)
    error_message = "kortix_cli_channel must be \"prod\" or \"dev\"."
  }
}

variable "auto_update" {
  description = "Whether the in-compose auto-updater is on (`on`/`off`). This is the ONLY thing that keeps the box current after Terraform provisions it once — Terraform never redeploys the app."
  type        = string
  default     = "on"

  validation {
    condition     = contains(["on", "off"], var.auto_update)
    error_message = "auto_update must be \"on\" or \"off\"."
  }
}

variable "admin_email" {
  description = "Optional admin email granted platform-admin on first boot (`kortix self-host init --admin-email`). Leave empty to skip and configure later via `kortix self-host configure`."
  type        = string
  default     = ""
}

variable "acme_email" {
  description = "Optional ACME (Let's Encrypt) contact email. Leave empty to use the CLI's own default (admin@<domain>)."
  type        = string
  default     = ""
}

# All variables here just pass through to modules/selfhost-ec2 — see that
# module's variables.tf / README.md for the authoritative description of each.
# Keeping the full surface here (rather than a handful with everything else
# hardcoded in main.tf) so a standalone `kortix-selfhost` repo doesn't need to
# reach into the module for anything a normal deployment would tune.

variable "aws_region" {
  description = "AWS region to provision the box in."
  type        = string
  default     = "us-east-1"
}

# ── Required ────────────────────────────────────────────────────────────────

variable "domain" {
  description = "Public domain to run this instance on, e.g. kortix.example.com. Its DNS A/AAAA record (and the API subdomain's) must point at the box's public IP for ACME HTTP-01 to issue a cert — either let this module manage it (set route53_zone_id) or point your own DNS at the public_ip output."
  type        = string
}

variable "admin_email" {
  description = "Email granted platform-admin on first boot. Leave empty to configure later via `kortix self-host configure` / the dashboard."
  type        = string
  default     = ""
}

# ── DNS ─────────────────────────────────────────────────────────────────────

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for var.domain. Leave empty to manage DNS yourself (the module still outputs the Elastic IP to point at)."
  type        = string
  default     = ""
}

variable "api_domain" {
  description = "API hostname to point at this box. Leave empty to default to api.<var.domain>."
  type        = string
  default     = ""
}

variable "dns_ttl" {
  description = "TTL (seconds) for the Route53 A records, when created."
  type        = number
  default     = 300
}

# ── Naming / tags ───────────────────────────────────────────────────────────

variable "name" {
  description = "Name prefix for all AWS resources."
  type        = string
  default     = "kortix-selfhost"
}

variable "tags" {
  description = "Extra tags applied to every resource this module creates."
  type        = map(string)
  default     = { Project = "kortix-selfhost" }
}

# ── Instance ────────────────────────────────────────────────────────────────

variable "instance_type" {
  description = "EC2 instance type. t3.xlarge (4 vCPU / 16GB) is a reasonable floor for the full stack."
  type        = string
  default     = "t3.xlarge"
}

variable "ami_id" {
  description = "AMI to launch. Leave empty to resolve the latest Ubuntu 24.04 LTS AMI automatically."
  type        = string
  default     = ""
}

variable "root_volume_size_gb" {
  description = "Root (OS) EBS volume size."
  type        = number
  default     = 30
}

variable "key_name" {
  description = "Optional EC2 key pair name for SSH. Leave empty to rely on SSM Session Manager only (recommended)."
  type        = string
  default     = ""
}

# ── Networking ──────────────────────────────────────────────────────────────

variable "vpc_id" {
  description = "VPC to launch into. Leave empty to use the account/region's default VPC."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Subnet to launch into. Leave empty to use a default subnet in the default VPC."
  type        = string
  default     = ""
}

variable "allowed_cidrs" {
  description = "CIDRs allowed to reach the box on 80/443. Restrict this once you know your users' egress ranges."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_ingress_cidrs" {
  description = "CIDRs allowed to reach port 22. Empty (default) opens no SSH ingress at all."
  type        = list(string)
  default     = []
}

# ── Data volume ─────────────────────────────────────────────────────────────

variable "data_volume_size_gb" {
  description = "Size of the separate EBS data volume holding all durable state (Docker + Postgres + Supabase Storage)."
  type        = number
  default     = 100
}

variable "data_volume_kms_key_id" {
  description = "Optional customer-managed KMS key ARN for the data volume."
  type        = string
  default     = ""
}

# ── Backups (DLM snapshot schedule for the data volume) ────────────────────

variable "backup_interval_hours" {
  description = "How often to snapshot the data volume, in hours. One of 1, 2, 3, 4, 6, 8, 12, 24 (AWS DLM's supported intervals). Default 24 (once daily) — set e.g. 6 for four snapshots a day."
  type        = number
  default     = 24
}

variable "backup_retention_count" {
  description = "How many snapshots to keep — stores up to this many backups before the oldest is pruned. Default 7."
  type        = number
  default     = 7
}

variable "snapshot_time" {
  description = "UTC time-of-day (HH:MM) the snapshot runs. Only meaningful when backup_interval_hours = 24."
  type        = string
  default     = "03:00"
}

# ── kortix self-host bootstrap ──────────────────────────────────────────────

variable "instance_name" {
  description = "The kortix self-host `--instance` name."
  type        = string
  default     = "default"
}

variable "kortix_channel" {
  description = "Image channel the stack tracks (`stable` or `latest`)."
  type        = string
  default     = "stable"
}

variable "kortix_version" {
  description = "Optional exact image tag to pin instead of tracking a channel (passed as `kortix self-host init --tag`)."
  type        = string
  default     = ""
}

variable "kortix_cli_install_url" {
  description = "URL for the one-click kortix CLI installer."
  type        = string
  default     = "https://kortix.com/install"
}

variable "kortix_cli_channel" {
  description = "Which CLI build the installer fetches: `prod` (default) or `dev` (tracks main — use this if the published prod CLI hasn't caught up yet to flags/behavior this deployment relies on)."
  type        = string
  default     = "prod"
}

variable "auto_update" {
  description = "Whether the in-compose auto-updater is on (`on`/`off`)."
  type        = string
  default     = "on"
}

variable "acme_email" {
  description = "Optional ACME (Let's Encrypt) contact email. Leave empty to use admin@<domain>."
  type        = string
  default     = ""
}

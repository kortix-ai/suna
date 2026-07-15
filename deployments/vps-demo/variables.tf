variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "domain" {
  type    = string
  default = "vps-demo.kortix.com"
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for vps-demo.kortix.com (a delegated subdomain zone — kortix.com itself is Cloudflare-authoritative, so this subdomain is NS-delegated from the Cloudflare kortix.com zone to this Route53 zone, same pattern the retired vpc-demo.kortix.com used)."
  type        = string
  default     = "Z07380351PAIRZS9726W1"
}

variable "admin_email" {
  description = "Comma-separated platform-admin email(s) — passed straight through to `kortix self-host init --admin-email`, which already accepts a CSV list (sets KORTIX_PLATFORM_ADMIN_EMAILS)."
  type        = string
  default     = "marko@kortix.ai,marko@kortix.com"
}

variable "instance_type" {
  type    = string
  default = "t3.xlarge"
}

variable "vpc_id" {
  description = "Reuses the same VPC the retired vpc-demo box lived in — this account/region has no default VPC."
  type        = string
  default     = "vpc-033fc5547c2e48a19"
}

variable "subnet_id" {
  description = "Reuses the same public subnet (routes to an IGW; MapPublicIpOnLaunch is false but irrelevant since the module associates an Elastic IP explicitly)."
  type        = string
  default     = "subnet-07a9e5c368353971b"
}

variable "data_volume_size_gb" {
  type    = number
  default = 100
}

variable "backup_interval_hours" {
  description = "Snapshot interval in hours. 24 (once daily) for this deploy."
  type        = number
  default     = 24
}

variable "backup_retention_count" {
  type    = number
  default = 10
}

variable "kortix_channel" {
  type    = string
  default = "stable"
}

variable "kortix_version" {
  description = "Exact app image tag to pin (kortix self-host init --tag). selfhost-rc is the release-candidate build for the generic self-host system this deployment exercises."
  type        = string
  default     = "selfhost-rc"
}

variable "kortix_cli_channel" {
  description = "prod|dev — which kortix CLI build the installer fetches. \"dev\" because the generic self-host CLI flags this module relies on (--admin-email, --tag on init, etc.) merged to main after the last tagged vX.Y.Z release — the prod CLI doesn't have them yet. Even the dev-latest prerelease can lag a branch still being iterated on same-day; the box's CLI is force-replaced post-apply with a binary compiled straight from branch HEAD (see the runbook / deploy report) whenever that's the case."
  type        = string
  default     = "dev"
}

variable "auto_update" {
  type    = string
  default = "on"
}

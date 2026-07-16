variable "aws_region" {
  description = "us-east-1 for parity with the vps-demo box (the essentia profile's own default region is us-west-2 — region is pinned here so the apply doesn't depend on profile config)."
  type        = string
  default     = "us-east-1"
}

variable "domain" {
  type    = string
  default = "essentia.kortix.cloud"
}

variable "admin_email" {
  description = "Comma-separated platform-admin email(s) — passed straight through to `kortix self-host init --admin-email` (sets KORTIX_PLATFORM_ADMIN_EMAILS)."
  type        = string
  default     = "marko@kortix.ai,marko@kortix.com"
}

variable "instance_type" {
  type    = string
  default = "t3.xlarge"
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
  description = "Exact app image tag to pin (kortix self-host init --tag). selfhost-rc is the release-candidate build for the generic self-host system — same tag the vps-demo box runs."
  type        = string
  default     = "selfhost-rc"
}

variable "kortix_cli_channel" {
  description = "prod|dev — which kortix CLI build the installer fetches. \"dev\" because the generic self-host CLI flags this module relies on (--admin-email, --tag on init, etc.) merged to main after the last tagged vX.Y.Z release — the prod CLI doesn't have them yet. Same reasoning as deployments/vps-demo."
  type        = string
  default     = "dev"
}

variable "auto_update" {
  type    = string
  default = "on"
}

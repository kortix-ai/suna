variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "domain" {
  type    = string
  default = "vpc-demo.kortix.com"
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for vpc-demo.kortix.com (a delegated subdomain zone, not the parent kortix.com zone)."
  type        = string
  default     = "Z08967081WIACA6008WUL"
}

variable "admin_email" {
  type    = string
  default = "marko@kortix.ai"
}

variable "instance_type" {
  type    = string
  default = "t3.xlarge"
}

variable "vpc_id" {
  description = "Reuses the same VPC the hand-deployed box lived in — this account/region has no default VPC."
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
  description = "Snapshot interval in hours. Daily (24) per the reviewed self-host default — stability over frequency."
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
  description = "prod|dev — which kortix CLI build the installer fetches. \"dev\" because the generic self-host CLI flags this module relies on (--admin-email, --single-account, --tag on init, etc.) merged to main after the last tagged vX.Y.Z release (v0.9.108) — the prod CLI doesn't have them yet."
  type        = string
  default     = "dev"
}

variable "auto_update" {
  type    = string
  default = "on"
}

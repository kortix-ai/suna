variable "name" {
  description = "Globally stable instance slug, for example vpc-demo or essentia. Do NOT prefix with kortix-; every resource is already named kortix-<name> (a kortix- prefix here would double it to kortix-kortix-...)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}[a-z0-9]$", var.name))
    error_message = "name must be a 4-32 character lowercase DNS slug."
  }

  validation {
    condition     = !startswith(var.name, "kortix-")
    error_message = "name must not start with 'kortix-'; resources are already named kortix-<name>."
  }
}

variable "expected_account_id" {
  description = "AWS account that owns this installation. Planning in any other account fails closed."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

variable "vpc_cidr" {
  description = "Dedicated, non-overlapping /16 CIDR for this installation."
  type        = string

  validation {
    condition = can(cidrsubnet(var.vpc_cidr, 4, 0)) && endswith(var.vpc_cidr, "/16") && (
      startswith(var.vpc_cidr, "10.") ||
      can(regex("^172\\.(1[6-9]|2[0-9]|3[01])\\.0\\.0/16$", var.vpc_cidr)) ||
      var.vpc_cidr == "192.168.0.0/16"
    )
    error_message = "vpc_cidr must be a canonical RFC1918 /16 CIDR."
  }
}

variable "api_domain" {
  description = "Customer API FQDN. An A record is created in route53_zone_id pointing at the appliance EIP; Caddy on the box terminates TLS via ACME."
  type        = string
}

variable "frontend_domain" {
  description = "Customer frontend FQDN. An A record is created in route53_zone_id pointing at the appliance EIP; Caddy on the box terminates TLS via ACME."
  type        = string
}

variable "route53_zone_id" {
  description = "Customer-owned public Route 53 hosted zone containing both application domains. Also used for ACME DNS-01 by the on-box updater via the instance role."
  type        = string

  validation {
    condition     = can(regex("^Z[A-Z0-9]{5,31}$", var.route53_zone_id))
    error_message = "route53_zone_id must be a Route 53 hosted zone ID."
  }
}

variable "acme_email" {
  description = "Contact email Caddy registers with the ACME CA (Let's Encrypt/ZeroSSL) for the appliance certificates. Optional; empty issues anonymously. Recommended so the CA can send expiry/revocation notices."
  type        = string
  default     = ""
}

# ── Ingress ───────────────────────────────────────────────────────────────────
variable "ingress_cidrs" {
  description = "CIDRs allowed to reach the appliance host on 80/443 (the whole customer-facing surface). Enterprise customers SHOULD restrict this to their corporate egress ranges; the open default exists only for first bring-up."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ── Bedrock (LLM upstream; the gateway SigV4-signs with the instance role) ─────
variable "bedrock_model_allowlist" {
  description = "Resource ARNs the instance role may invoke via bedrock:InvokeModel[WithResponseStream]. Defaults to Anthropic foundation models and cross-region inference profiles; restrict per certification."
  type        = list(string)
  default = [
    "arn:aws:bedrock:*::foundation-model/anthropic.*",
    "arn:aws:bedrock:*:*:inference-profile/*anthropic.*",
    "arn:aws:bedrock:*:*:application-inference-profile/*",
  ]
}

# ── Appliance EC2 (runs the whole product: Caddy + api/gateway/frontend + Supabase) ─
variable "appliance_instance_type" {
  description = "EC2 instance type for the single-box appliance. Sized for Supabase plus api (x2) + gateway + frontend + Caddy on one host."
  type        = string
  default     = "m7i.2xlarge"
}

variable "appliance_ami_id" {
  description = "Optional reviewed AL2023 AMI. Null resolves the current AWS AL2023 x86_64 image during plan."
  type        = string
  default     = null
}

variable "root_volume_size_gib" {
  description = "Encrypted root volume size (GiB). Sized with headroom for Docker image churn between prunes."
  type        = number
  default     = 100

  validation {
    condition     = var.root_volume_size_gib >= 50
    error_message = "Root volume must be at least 50 GiB."
  }
}

variable "data_volume_size_gib" {
  type    = number
  default = 500

  validation {
    condition     = var.data_volume_size_gib >= 100
    error_message = "Data volume must be at least 100 GiB."
  }
}

variable "data_volume_iops" {
  type    = number
  default = 6000
}

variable "data_volume_throughput" {
  type    = number
  default = 250
}

variable "disk_used_percent_alarm_threshold" {
  description = "CloudWatch alarm threshold (%%) on the data volume's used space, published by the CloudWatch agent."
  type        = number
  default     = 85
}

# ── Signed-release / updater configuration ────────────────────────────────────
variable "release_repository_url" {
  description = "HTTPS base URL of the immutable enterprise TUF repository the deployer fetches and verifies."
  type        = string

  validation {
    condition     = startswith(var.release_repository_url, "https://")
    error_message = "release_repository_url must use HTTPS."
  }
}

variable "tuf_root_sha256" {
  description = "Offline-reviewed SHA-256 of the trusted TUF root the deployer pins."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.tuf_root_sha256))
    error_message = "tuf_root_sha256 must be a lowercase SHA-256 digest."
  }
}

variable "release_channel" {
  description = "Enterprise channel. Managed VPCs must track stable."
  type        = string
  default     = "stable"

  validation {
    condition     = var.release_channel == "stable"
    error_message = "Enterprise installations may only track the stable channel."
  }
}

variable "image_repositories" {
  description = "Customer-owned ECR repositories populated by the signed deployer. Release bundles remain authenticated TUF targets and are not duplicated as OCI images."
  type        = set(string)
  default     = ["api", "frontend", "gateway"]

  validation {
    condition     = length(setsubtract(toset(["api", "frontend", "gateway"]), var.image_repositories)) == 0
    error_message = "image_repositories must include api, frontend, and gateway."
  }
}

variable "maintenance_window" {
  description = "UTC maintenance window passed to the signed deployer (for example Sun:02:00-05:00)."
  type        = string
  default     = "Sun:02:00-05:00"
}

# ── Operator / boundaries / state ─────────────────────────────────────────────
variable "operator_principal_arns" {
  description = "Customer-approved IAM principals allowed to assume the time-limited operator role. Empty disables operator access."
  type        = list(string)
  default     = []
}

variable "operator_external_id" {
  description = "External ID required for operator role assumption. Required when operator principals are configured."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = length(var.operator_principal_arns) == 0 || try(length(var.operator_external_id) >= 16, false)
    error_message = "operator_external_id of at least 16 characters is required when operator principals are configured."
  }
}

variable "permissions_boundary_arn" {
  description = "Reviewed customer-owned IAM permissions boundary attached to every runtime and deployer role. The state bootstrap module creates the default boundary."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:iam::${var.expected_account_id}:policy/.+$", var.permissions_boundary_arn))
    error_message = "permissions_boundary_arn must be a managed-policy ARN owned by expected_account_id."
  }
}

variable "backup_retention_days" {
  type    = number
  default = 35

  validation {
    condition     = var.backup_retention_days >= 35
    error_message = "Enterprise backup retention must be at least 35 days."
  }
}

variable "protect_from_destroy" {
  description = "Enable EC2 termination and EBS deletion protection. Disable only through a reviewed decommission procedure."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional customer tags. Kortix ownership tags are always added."
  type        = map(string)
  default     = {}
}

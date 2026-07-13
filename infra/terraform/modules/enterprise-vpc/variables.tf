variable "name" {
  description = "Globally stable instance slug, for example kortix-vpc-demo or essentia."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}[a-z0-9]$", var.name))
    error_message = "name must be a 4-32 character lowercase DNS slug."
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

variable "cluster_version" {
  description = "EKS Kubernetes minor version."
  type        = string
  default     = "1.32"
}

variable "node_instance_types" {
  description = "On-demand EKS application node types."
  type        = list(string)
  default     = ["m7i.large"]
}

variable "node_desired_size" {
  type    = number
  default = 3
}

variable "node_min_size" {
  type    = number
  default = 3
}

variable "node_max_size" {
  type    = number
  default = 9
}

variable "app_namespace" {
  description = "Namespace for Kortix frontend, API, workers, and gateway."
  type        = string
  default     = "kortix-app"
}

variable "app_service_account" {
  description = "IRSA-enabled service account used by Kortix workloads and External Secrets."
  type        = string
  default     = "kortix"
}

variable "api_domain" {
  description = "Customer API FQDN covered by ACM and managed during platform bootstrap."
  type        = string
}

variable "frontend_domain" {
  description = "Customer frontend FQDN covered by ACM and managed during platform bootstrap."
  type        = string
}

variable "supabase_instance_type" {
  description = "Private EC2 instance type for the single-tenant Supabase Docker stack."
  type        = string
  default     = "r7i.xlarge"
}

variable "supabase_ami_id" {
  description = "Optional reviewed AL2023 AMI. Null resolves the current AWS AL2023 x86_64 image during plan."
  type        = string
  default     = null
}

variable "supabase_data_volume_size_gib" {
  type    = number
  default = 500

  validation {
    condition     = var.supabase_data_volume_size_gib >= 100
    error_message = "Supabase data volume must be at least 100 GiB."
  }
}

variable "supabase_data_volume_iops" {
  type    = number
  default = 6000
}

variable "supabase_data_volume_throughput" {
  type    = number
  default = 250
}

variable "release_repository_url" {
  description = "HTTPS base URL of the immutable enterprise TUF repository."
  type        = string

  validation {
    condition     = startswith(var.release_repository_url, "https://")
    error_message = "release_repository_url must use HTTPS."
  }
}

variable "tuf_root_sha256" {
  description = "Offline-reviewed SHA-256 of the trusted TUF root embedded at install time."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.tuf_root_sha256))
    error_message = "tuf_root_sha256 must be a lowercase SHA-256 digest."
  }
}

variable "updater_bootstrap_url" {
  description = "HTTPS URL for the minimal updater bootstrap binary."
  type        = string

  validation {
    condition     = startswith(var.updater_bootstrap_url, "https://")
    error_message = "updater_bootstrap_url must use HTTPS."
  }
}

variable "updater_bootstrap_sha256" {
  description = "Pinned digest of the updater bootstrap; it then verifies all releases through TUF."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.updater_bootstrap_sha256))
    error_message = "updater_bootstrap_sha256 must be a lowercase SHA-256 digest."
  }
}

variable "release_publisher_account_id" {
  description = "Kortix AWS account allowed to PutEvents release hints on this customer's bus. Hints never authorize an update."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.release_publisher_account_id))
    error_message = "release_publisher_account_id must be a 12-digit AWS account ID."
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
  description = "Customer-owned ECR repositories populated by the signed updater. The release-bundle repository stores signed OCI bundles as well as rollback metadata."
  type        = set(string)
  default     = ["api", "frontend", "gateway", "migrate", "release-bundle"]

  validation {
    condition     = length(setsubtract(toset(["api", "frontend", "gateway", "migrate", "release-bundle"]), var.image_repositories)) == 0
    error_message = "image_repositories must include api, frontend, gateway, migrate, and release-bundle."
  }
}

variable "maintenance_window" {
  description = "UTC maintenance window passed to the signed updater (for example Sun:02:00-05:00)."
  type        = string
  default     = "Sun:02:00-05:00"
}

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
  description = "Reviewed customer-owned IAM permissions boundary attached to every runtime and updater role. The state bootstrap module creates the default boundary."
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

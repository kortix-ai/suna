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
  description = "Customer API FQDN covered by ACM and pointed at the shared ALB."
  type        = string
}

variable "frontend_domain" {
  description = "Customer frontend FQDN covered by ACM and pointed at the shared ALB."
  type        = string
}

variable "route53_zone_id" {
  description = "Customer-owned public Route 53 hosted zone containing both application domains."
  type        = string

  validation {
    condition     = can(regex("^Z[A-Z0-9]{5,31}$", var.route53_zone_id))
    error_message = "route53_zone_id must be a Route 53 hosted zone ID."
  }
}

# ── ECS service images (digest-pinned by the deployer at runtime) ──────────────
variable "placeholder_image" {
  description = "Long-lived, no-op public image seeded into every task-def until the deployer rolls a signed, digest-pinned image from customer ECR. Its default entrypoint blocks forever so tasks do not crash-loop before the first deploy."
  type        = string
  default     = "public.ecr.aws/eks-distro/kubernetes/pause:3.9"
}

variable "api_image" {
  description = "Initial API image ref. Null seeds the placeholder; the deployer owns real revisions (services ignore task_definition changes)."
  type        = string
  default     = null
}

variable "gateway_image" {
  description = "Initial gateway image ref. Null seeds the placeholder."
  type        = string
  default     = null
}

variable "frontend_image" {
  description = "Initial frontend image ref. Null seeds the placeholder."
  type        = string
  default     = null
}

variable "deployer_image" {
  description = "Slim enterprise-updater/deployer image ref (apps/enterprise-updater). Null seeds the placeholder; the deploy tooling owns real revisions."
  type        = string
  default     = null
}

variable "deployer_command" {
  description = "Command for the one-off deployer task. Empty uses the image's own entrypoint."
  type        = list(string)
  default     = ["reconcile"]
}

variable "runtime_secret_keys" {
  description = "Optional seed list of JSON keys inside <instance>/runtime to wire as container secrets. The deployer re-derives the authoritative full set from the live secret on every roll (the ecs-deploy.sh pattern), so this can stay empty; the execution role can read every key regardless."
  type        = list(string)
  default     = []
}

# ── ECS sizing / autoscaling ──────────────────────────────────────────────────
variable "api_task_cpu" {
  type    = number
  default = 1024
}

variable "api_task_memory" {
  type    = number
  default = 2048
}

variable "api_min_capacity" {
  description = "Autoscaling floor for the api service. Enterprise HA requires >= 2."
  type        = number
  default     = 2
}

variable "api_max_capacity" {
  type    = number
  default = 6
}

variable "gateway_task_cpu" {
  type    = number
  default = 512
}

variable "gateway_task_memory" {
  type    = number
  default = 1024
}

variable "gateway_min_capacity" {
  description = "Autoscaling floor for the gateway service. Enterprise HA requires >= 2."
  type        = number
  default     = 2
}

variable "gateway_max_capacity" {
  type    = number
  default = 4
}

variable "frontend_task_cpu" {
  type    = number
  default = 512
}

variable "frontend_task_memory" {
  type    = number
  default = 1024
}

variable "frontend_desired_count" {
  type    = number
  default = 2
}

variable "migrate_task_cpu" {
  type    = number
  default = 1024
}

variable "migrate_task_memory" {
  type    = number
  default = 2048
}

variable "deployer_task_cpu" {
  type    = number
  default = 512
}

variable "deployer_task_memory" {
  type    = number
  default = 1024
}

variable "cpu_target" {
  description = "Target average CPU %% for target-tracking autoscaling."
  type        = number
  default     = 60
}

variable "memory_target" {
  description = "Target average memory %% for target-tracking autoscaling."
  type        = number
  default     = 70
}

# ── ALB ───────────────────────────────────────────────────────────────────────
variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to reach the public ALB. Enterprise customers SHOULD restrict this to their corporate egress ranges; the open default exists only for first bring-up."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "alb_idle_timeout" {
  description = "ALB idle timeout (s). Raised for long-lived/streaming agent responses."
  type        = number
  default     = 300
}

variable "log_retention_days" {
  description = "CloudWatch retention for ECS task logs."
  type        = number
  default     = 365
}

# ── Bedrock (LLM upstream for the gateway task role) ──────────────────────────
variable "bedrock_model_allowlist" {
  description = "Resource ARNs the gateway task role may invoke via bedrock:InvokeModel[WithResponseStream]. Defaults to Anthropic foundation models and cross-region inference profiles; restrict per certification."
  type        = list(string)
  default = [
    "arn:aws:bedrock:*::foundation-model/anthropic.*",
    "arn:aws:bedrock:*:*:inference-profile/*anthropic.*",
    "arn:aws:bedrock:*:*:application-inference-profile/*",
  ]
}

# ── Scheduled deploy (auto-update check) ──────────────────────────────────────
variable "enable_scheduled_deploy" {
  description = "Create the EventBridge Scheduler rule that runs the deployer task daily. The deployer exits 0 when running digests already match the stable manifest."
  type        = bool
  default     = true
}

variable "scheduler_schedule_expression" {
  description = "EventBridge Scheduler expression for the daily auto-update check."
  type        = string
  default     = "rate(1 day)"
}

# ── Supabase EC2 ──────────────────────────────────────────────────────────────
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

# ── Signed-release / deployer configuration ───────────────────────────────────
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

variable "terraform_state_bucket" {
  description = "Customer-owned remote-state bucket used by the private platform stage."
  type        = string
}

variable "terraform_state_lock_table" {
  description = "Customer-owned DynamoDB lock table used by the private platform stage."
  type        = string
}

variable "terraform_state_kms_key_arn" {
  description = "Customer-owned KMS key protecting remote Terraform state."
  type        = string
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

variable "aws_region" {
  description = "AWS region for the EKS prod resources."
  type        = string
  default     = "us-west-2"
}

variable "vpc_cidr" {
  description = "CIDR for the EKS VPC. MUST NOT overlap the ECS VPCs (dev 10.10/16, prod 10.20/16)."
  type        = string
  default     = "10.30.0.0/16"
}

variable "cluster_version" {
  description = "EKS Kubernetes minor version."
  type        = string
  default     = "1.32"
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "CIDRs allowed to reach the public Kubernetes API endpoint. Tighten to office/CI egress for prod."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ── Node group ────────────────────────────────────────────────────────────────
variable "node_instance_types" {
  description = "Managed node group instance types."
  type        = list(string)
  default     = ["m6i.large"]
}

variable "node_desired_size" {
  description = "Initial node count (>= 3 for one-per-AZ across 3 AZs)."
  type        = number
  default     = 3
}

variable "node_min_size" {
  description = "Node autoscaling floor (keep >= 3 for HA spread)."
  type        = number
  default     = 3
}

variable "node_max_size" {
  description = "Node autoscaling ceiling."
  type        = number
  default     = 9
}

# ── App / secrets wiring ──────────────────────────────────────────────────────
variable "app_namespace" {
  description = "Kubernetes namespace the API runs in."
  type        = string
  default     = "kortix-prod"
}

variable "app_service_account" {
  description = "ServiceAccount the API pods + the SecretStore use (gets the secret-read IRSA role)."
  type        = string
  default     = "kortix-api"
}

variable "app_secret_name" {
  description = "Secrets Manager secret the app reads — the SAME bundle ECS prod uses. This is the FRIENDLY name (no random ARN suffix); the ECS task references it by full ARN (kortix-prod-env-omifd2)."
  type        = string
  default     = "kortix-prod-env"
}

# ── DNS / TLS (Cloudflare) ────────────────────────────────────────────────────
variable "api_domain" {
  description = "Public FQDN for the EKS API (parallel to ECS's api-prod/api.kortix.com)."
  type        = string
  default     = "api-eks.kortix.com"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kortix.com. Supply via TF_VAR_cloudflare_zone_id."
  type        = string
  default     = ""
}

variable "cloudflare_api_token" {
  description = "Cloudflare scoped API token. Supply via TF_VAR_cloudflare_api_token."
  type        = string
  default     = ""
  sensitive   = true
}

variable "cloudflare_email" {
  description = "Cloudflare account email (for global-API-key auth)."
  type        = string
  default     = ""
}

variable "cloudflare_api_key" {
  description = "Cloudflare global API key (alternative to a scoped token)."
  type        = string
  default     = ""
  sensitive   = true
}

# ── CI / access ───────────────────────────────────────────────────────────────
variable "github_repo" {
  description = "owner/repo allowed to assume the CI deploy role via OIDC."
  type        = string
  default     = "kortix-ai/suna"
}

variable "ci_deploy_role_name" {
  description = "Name of the GitHub Actions EKS deploy role."
  type        = string
  default     = "kortix-gha-eks-deploy"
}

variable "admin_principal_arns" {
  description = "Extra IAM principal ARNs to grant cluster-admin (besides whoever applies)."
  type        = list(string)
  default     = []
}

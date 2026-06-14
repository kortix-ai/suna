variable "aws_region" {
  description = "AWS region for the EKS dev resources."
  type        = string
  default     = "us-west-2"
}

variable "vpc_cidr" {
  description = "CIDR for the EKS VPC. MUST NOT overlap the other VPCs (ECS dev 10.10/16, ECS prod 10.20/16, prod-eks 10.30/16)."
  type        = string
  default     = "10.40.0.0/16"
}

variable "cluster_version" {
  description = "EKS Kubernetes minor version."
  type        = string
  default     = "1.32"
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "CIDRs allowed to reach the public Kubernetes API endpoint."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ── Node group (dev-sized; smaller floor than prod's 3) ───────────────────────
variable "node_instance_types" {
  description = "Managed node group instance types."
  type        = list(string)
  default     = ["m6i.large"]
}

variable "node_desired_size" {
  description = "Initial node count."
  type        = number
  default     = 1
}

variable "node_min_size" {
  description = "Node autoscaling floor. 1 for dev (≤100 users) — the cluster-autoscaler bursts up for preview envs and scales back to a single node when idle."
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Node autoscaling ceiling (headroom for concurrent preview envs)."
  type        = number
  default     = 4
}

# ── App / secrets wiring ──────────────────────────────────────────────────────
variable "app_namespace" {
  description = "Kubernetes namespace the API runs in."
  type        = string
  default     = "kortix-dev"
}

variable "app_service_account" {
  description = "ServiceAccount the API pods + the SecretStore use (gets the secret-read IRSA role)."
  type        = string
  default     = "kortix-api"
}

variable "app_secret_name" {
  description = "Secrets Manager secret the app reads — the dev bundle (FRIENDLY name, no random ARN suffix). Same bundle the ECS dev tier sources its secrets from."
  type        = string
  default     = "kortix-dev-env"
}

# ── DNS / TLS (Cloudflare) ────────────────────────────────────────────────────
variable "api_domain" {
  description = "Public FQDN for the EKS dev API (parallel to ECS's dev-api.kortix.com)."
  type        = string
  default     = "dev-api-eks.kortix.com"
}

variable "argocd_domain" {
  description = "FQDN reserved for the dev Argo CD UI (UI is OFF by default; cert created for parity)."
  type        = string
  default     = "dev-ops.kortix.com"
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
  description = "Name of the GitHub Actions EKS dev deploy role."
  type        = string
  default     = "kortix-gha-eks-deploy-dev"
}

variable "admin_principal_arns" {
  description = "Extra IAM principal ARNs to grant cluster-admin (besides whoever applies)."
  type        = list(string)
  default     = []
}

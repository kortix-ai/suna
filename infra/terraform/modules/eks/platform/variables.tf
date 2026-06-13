variable "cluster_name" {
  description = "EKS cluster name (from modules/eks/cluster)."
  type        = string
}

variable "aws_region" {
  description = "AWS region."
  type        = string
}

variable "vpc_id" {
  description = "VPC the cluster runs in (the ALB controller needs it)."
  type        = string
}

variable "oidc_provider_arn" {
  description = "Cluster IAM OIDC provider ARN."
  type        = string
}

variable "oidc_provider_url" {
  description = "Cluster OIDC issuer URL without scheme."
  type        = string
}

variable "api_domain" {
  description = "Public API hostname external-dns manages (e.g. api-eks.kortix.com). Doubles as the external-dns domainFilter so it can't touch any other record."
  type        = string
}

variable "extra_domain_filters" {
  description = "Extra external-dns domain filters beyond api_domain — e.g. preview-api.kortix.com so external-dns auto-manages per-PR preview records. Empty by default (single-host)."
  type        = list(string)
  default     = []
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token external-dns uses to manage the record (DNS edit on the kortix.com zone)."
  type        = string
  sensitive   = true
}

# ── Pinned chart versions ─────────────────────────────────────────────────────
variable "alb_controller_chart_version" {
  type    = string
  default = "1.8.1" # app v2.8.1
}

variable "external_secrets_chart_version" {
  type    = string
  default = "0.10.4"
}

variable "external_dns_chart_version" {
  type    = string
  default = "1.15.0"
}

variable "metrics_server_chart_version" {
  type    = string
  default = "3.12.1"
}

variable "cluster_autoscaler_chart_version" {
  type    = string
  default = "9.37.0"
}

variable "argo_cd_chart_version" {
  type    = string
  default = "7.6.12" # app v2.12.x
}

variable "argo_rollouts_chart_version" {
  type    = string
  default = "2.37.3" # app v1.7.x
}

# ── Argo CD UI exposure (ops.kortix.com) ──────────────────────────────────────
variable "argocd_ui_enabled" {
  description = "Expose the Argo CD UI on its own ALB at argocd_domain. Gate it with Cloudflare Access (see infra/GITOPS.md) before adding the DNS record."
  type        = bool
  default     = false
}

variable "argocd_domain" {
  description = "Public FQDN for the Argo CD UI."
  type        = string
  default     = "ops.kortix.com"
}

variable "argocd_certificate_arn" {
  description = "ACM cert ARN for the Argo CD UI ALB (from the cluster layer)."
  type        = string
  default     = ""
}

# ── Argo CD GitHub-org SSO ────────────────────────────────────────────────────
variable "argocd_github_sso_enabled" {
  description = "Enable GitHub-org SSO (Dex) for Argo CD login."
  type        = bool
  default     = false
}

variable "argocd_github_org" {
  description = "GitHub org whose members may log in to Argo CD."
  type        = string
  default     = "kortix-ai"
}

variable "argocd_admin_team" {
  description = "GitHub team (within the org) granted Argo CD admin; everyone else in the org is read-only."
  type        = string
  default     = "eng"
}

variable "argocd_github_client_id" {
  description = "GitHub OAuth App client ID for Argo CD SSO."
  type        = string
  default     = ""
}

variable "argocd_github_client_secret" {
  description = "GitHub OAuth App client secret. Supply via TF_VAR_argocd_github_client_secret."
  type        = string
  default     = ""
  sensitive   = true
}

variable "argocd_disable_admin" {
  description = "Disable the built-in Argo CD admin account (do this ONLY after SSO login is verified, or you'll lock yourself out)."
  type        = bool
  default     = false
}

variable "cloudflare_inbound_cidrs" {
  description = "CIDRs allowed to hit the Argo CD ALB — locked to Cloudflare's ranges so the Cloudflare Access gate can't be bypassed via the raw ALB DNS."
  type        = list(string)
  default = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
}

variable "tags" {
  type    = map(string)
  default = {}
}

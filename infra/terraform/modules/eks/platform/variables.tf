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

variable "tags" {
  type    = map(string)
  default = {}
}

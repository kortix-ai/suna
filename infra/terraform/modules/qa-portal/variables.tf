# Inputs for the QA report portal module. The OIDC values come from the
# modules/eks/cluster outputs (oidc_provider_arn / oidc_provider_url) — pass them
# straight through from the calling environment, exactly like modules/eks/irsa.

variable "name" {
  description = "Name prefix for the IAM role/policy (e.g. kortix-qa-portal)."
  type        = string
  default     = "kortix-qa-portal"
}

variable "bucket_name" {
  description = "S3 bucket that stores Allure results + generated reports. Globally unique."
  type        = string
  default     = "kortix-qa-reports"
}

# ── IRSA wiring (read role for the portal pod) ────────────────────────────────
variable "oidc_provider_arn" {
  description = "Cluster IAM OIDC provider ARN (from modules/eks/cluster output oidc_provider_arn)."
  type        = string
}

variable "oidc_provider_url" {
  description = "Cluster OIDC issuer URL without scheme (from modules/eks/cluster output oidc_provider_url)."
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace the portal pod runs in."
  type        = string
  default     = "kortix-qa"
}

variable "service_account" {
  description = "ServiceAccount name the portal pod uses (gets the read IRSA role annotation)."
  type        = string
  default     = "qa-portal"
}

# ── CI write access (optional) ────────────────────────────────────────────────
# The CI job that uploads Allure results + the generated report needs write. Give
# it either an existing role ARN (assumed via GitHub OIDC) or leave empty to skip.
variable "ci_writer_role_arn" {
  description = "IAM role ARN the CI uploader assumes; granted write to the bucket. \"\" = don't attach a CI write policy."
  type        = string
  default     = ""
}

# ── Lifecycle ─────────────────────────────────────────────────────────────────
variable "per_run_retention_days" {
  description = "Expire old per-run reports/results under reports/runs/ after N days. The latest pointer (reports/latest/) and history index are kept."
  type        = number
  default     = 30
}

variable "noncurrent_version_retention_days" {
  description = "Expire noncurrent (overwritten) object versions after N days — versioning keeps the last write recoverable without hoarding every revision forever."
  type        = number
  default     = 30
}

# ── DNS (optional, single record) ─────────────────────────────────────────────
# When the portal Ingress is up, point qa.kortix.com at the ALB. external-dns can
# also do this from the Ingress annotations (the chart sets them); set
# manage_dns_record = true only if you want Terraform to own the record instead.
variable "manage_dns_record" {
  description = "If true, create the qa.kortix.com Cloudflare record here. Leave false to let the chart's external-dns annotation manage it."
  type        = bool
  default     = false
}

variable "dns_zone_id" {
  description = "Cloudflare zone ID for kortix.com (only used when manage_dns_record = true)."
  type        = string
  default     = ""
}

variable "host" {
  description = "Public FQDN for the portal."
  type        = string
  default     = "qa.kortix.com"
}

variable "alb_hostname" {
  description = "ALB DNS name the qa.kortix.com record should CNAME to (from `kubectl -n kortix-qa get ingress`). Only used when manage_dns_record = true."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ── Cloudflare Access gate (optional) ─────────────────────────────────────────
variable "enable_access" {
  description = "Put qa.kortix.com behind Cloudflare Access (Zero Trust). Denies by default; only the allowlist below can open reports."
  type        = bool
  default     = true
}

variable "create_access_policy" {
  description = "Create the inline allow policy. Set false when the account already attaches reusable org policies to the app (they'd collide on precedence)."
  type        = bool
  default     = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Zero Trust org. Required when enable_access = true. Supply via TF_VAR_cloudflare_account_id."
  type        = string
  default     = ""
}

variable "access_app_name" {
  description = "Display name of the Cloudflare Access application."
  type        = string
  default     = "QA Reports (qa.kortix.com)"
}

variable "access_allowed_email_domains" {
  description = "Email domains allowed through the Access gate."
  type        = list(string)
  default     = ["kortix.com"]
}

variable "access_allowed_emails" {
  description = "Additional individual emails allowed through the Access gate (contractors, on-call)."
  type        = list(string)
  default     = []
}

variable "access_session_duration" {
  description = "How long an authenticated Access session lasts before re-auth."
  type        = string
  default     = "24h"
}

variable "access_app_launcher_visible" {
  description = "Show the portal in the Cloudflare Access app launcher."
  type        = bool
  default     = true
}

variable "argocd_ui_enabled" {
  description = <<-EOT
    Expose the Argo CD UI on its own ALB at dev-ops.kortix.com. OFF by default
    for dev (access via `kubectl -n argocd port-forward`). Set true only AFTER
    setting up the Cloudflare Access gate (see infra/GITOPS.md).
  EOT
  type        = bool
  default     = false
}

variable "argocd_github_sso_enabled" {
  description = "Enable GitHub-org SSO for Argo CD login."
  type        = bool
  default     = false
}

variable "argocd_github_org" {
  description = "GitHub org whose members may log in to Argo CD."
  type        = string
  default     = "kortix-ai"
}

variable "argocd_admin_team" {
  description = "GitHub team granted Argo CD admin (others in the org are read-only)."
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
  description = "Disable Argo CD's built-in admin account (set true ONLY after SSO is verified)."
  type        = bool
  default     = false
}

variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token external-dns uses to manage the dev-api-eks.kortix.com
    record on the kortix.com zone (DNS:Edit). Supply via
    TF_VAR_cloudflare_api_token. Everything else is read from the cluster layer's
    remote state.
  EOT
  type        = string
  sensitive   = true
}

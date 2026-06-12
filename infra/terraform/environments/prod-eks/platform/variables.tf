variable "argocd_ui_enabled" {
  description = <<-EOT
    Expose the Argo CD UI on its own ALB at ops.kortix.com. Set true only AFTER
    setting up the Cloudflare Access gate (see infra/GITOPS.md) — the ALB is
    locked to Cloudflare IPs, and the DNS record is added last, so the UI is
    never publicly reachable-by-name before Access is in place.
  EOT
  type        = bool
  default     = false
}

variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token external-dns uses to manage the api-eks.kortix.com
    record on the kortix.com zone (DNS:Edit). Supply via
    TF_VAR_cloudflare_api_token. Everything else is read from the cluster layer's
    remote state.
  EOT
  type        = string
  sensitive   = true
}

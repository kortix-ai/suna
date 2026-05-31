variable "aws_region" {
  description = "AWS region for the prod resources."
  type        = string
  default     = "us-west-2"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kortix.com. Supply via TF_VAR_cloudflare_zone_id."
  type        = string
  default     = ""
}

variable "manage_dns" {
  description = <<-EOT
    Whether terraform creates the public api.kortix.com CNAME. Keep false during
    bring-up so the live record (pointing at the old prod box) is untouched —
    the stack builds + validates first. The cutover repoints api.kortix.com at
    this ALB out-of-band (reversible). ACM validation records are always created.
  EOT
  type        = bool
  default     = false
}

variable "api_domain" {
  description = <<-EOT
    Public FQDN for the prod API. Defaults to the final api.kortix.com, but the
    stack is first brought up under new-api.kortix.com (set api_domain =
    "new-api.kortix.com" in tfvars) so it runs in parallel with the live
    Lightsail prod without touching api.kortix.com. At go-live, change this back
    to "api.kortix.com" and re-apply — the ALB/ECS/cert all just re-point, no
    rebuild. The Cloudflare record name + ACM SAN derive from this.
  EOT
  type        = string
  default     = "api.kortix.com"
}

variable "cloudflare_api_token" {
  description = "Cloudflare scoped API token (= CLOUDFLARE_API_TOKEN secret). Supply via TF_VAR_cloudflare_api_token."
  type        = string
  default     = ""
  sensitive   = true
}

variable "cloudflare_email" {
  description = "Cloudflare account email (for global-API-key auth, when no scoped token is used)."
  type        = string
  default     = ""
}

variable "cloudflare_api_key" {
  description = "Cloudflare global API key (alternative to a scoped token). Supply via TF_VAR_cloudflare_api_key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "api_image" {
  description = "Container image for the API (pin to a release tag/sha in prod)."
  type        = string
  default     = "ghcr.io/kortix-ai/kortix-api:latest"
}

variable "container_port" {
  description = "Port the API container listens on."
  type        = number
  default     = 8000
}

variable "api_environment" {
  description = "Non-secret env vars for the API container."
  type        = map(string)
  default     = {}
}

variable "api_secrets" {
  description = "Secret env vars: name -> Secrets Manager/SSM ARN."
  type        = map(string)
  default     = {}
}

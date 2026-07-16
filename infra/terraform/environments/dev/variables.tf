variable "aws_region" {
  description = "AWS region for the dev resources."
  type        = string
  default     = "us-west-2"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kortix.com. Supply via TF_VAR_cloudflare_zone_id."
  type        = string
  default     = ""
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
  description = "Container image for the API (e.g. ghcr.io/kortix-ai/kortix-api:<tag>)."
  type        = string
  default     = "ghcr.io/kortix-ai/kortix-api:latest"
}

variable "gateway_image" {
  description = "Container image for the gateway (LLM proxy). CI rolls new revisions; Terraform only seeds the initial task-def."
  type        = string
  default     = "kortix/kortix-gateway:dev-latest"
}

variable "gateway_environment" {
  description = "Non-secret env vars for the gateway container (besides PORT and KORTIX_API_URL, which are set by the module/env)."
  type        = map(string)
  default     = {}
}

variable "gateway_certificate_arn" {
  description = "ACM cert for the gateway ALB. Must cover the gateway origin hostname (gateway-<env>-ecs-fargate) for Cloudflare Full(strict). Default: the us-west-2 *.kortix.com wildcard."
  type        = string
  default     = "arn:aws:acm:us-west-2:935064898258:certificate/d70f1f49-d981-4add-abb6-971bad1f3755"
}

variable "container_port" {
  description = "Port the API container listens on."
  type        = number
  default     = 8000
}

variable "api_environment" {
  description = "Non-secret env vars for the API container (KORTIX_URL, DATABASE host, etc.)."
  type        = map(string)
  default     = {}
}

variable "api_secrets" {
  description = "Secret env vars: name -> Secrets Manager/SSM ARN. Populate via tfvars; never inline secret values."
  type        = map(string)
  default     = {}
}

variable "enable_https" {
  description = "Create the ACM cert + HTTPS listener (needs the Cloudflare token for DNS validation). false = HTTP-only ALB, e.g. for parallel validation."
  type        = bool
  default     = true
}

variable "manage_dns" {
  description = "Manage the dev-api Cloudflare record (CNAME -> ALB). false = leave DNS untouched (no cutover)."
  type        = bool
  default     = true
}

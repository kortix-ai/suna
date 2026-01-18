variable "cloudflare_api_key" {
  description = "Cloudflare Global API Key"
  type        = string
  sensitive   = true
}

variable "cloudflare_email" {
  description = "Cloudflare account email"
  type        = string
  default     = "marko@kortix.ai"
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
  default     = "9785405a992435bb0c7bd19f9b6d26d5"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kortix.com"
  type        = string
  default     = "af378d3df4e4dd5052a1fcbf263b685d"
}

variable "acm_certificate_arn" {
  description = "ARN of ACM certificate for api.kortix.com"
  type        = string
  default     = "arn:aws:acm:us-west-2:935064898258:certificate/bc99f310-e64d-44fe-a161-d33bb8abf86d"
}

variable "container_image" {
  description = "Container image for ECS tasks"
  type        = string
  default     = "ghcr.io/kortix-ai/suna/suna-backend:prod"
}

variable "secrets_arn" {
  description = "ARN of Secrets Manager secret for environment variables"
  type        = string
  default     = "arn:aws:secretsmanager:us-west-2:935064898258:secret:suna-env-35648ec-j3MF94"
}

variable "active_backend" {
  description = "Active backend for Cloudflare Worker (lightsail or ecs)"
  type        = string
  default     = "lightsail"
}

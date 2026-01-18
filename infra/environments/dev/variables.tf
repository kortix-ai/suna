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

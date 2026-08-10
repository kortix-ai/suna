variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
  default   = ""
}

variable "cloudflare_zone_id" {
  type    = string
  default = "af378d3df4e4dd5052a1fcbf263b685d"
}

variable "postgres_egress_cidrs" {
  description = "Operator-verified CIDRs for the shared preview PostgreSQL endpoint. Never use 0.0.0.0/0."
  type        = list(string)
  validation {
    condition     = length(var.postgres_egress_cidrs) > 0 && !contains(var.postgres_egress_cidrs, "0.0.0.0/0")
    error_message = "postgres_egress_cidrs must contain at least one bounded CIDR and must not contain 0.0.0.0/0."
  }
}

variable "preview_certificate_arn" {
  description = "Existing issued ACM certificate for *.preview-api.kortix.com."
  type        = string
  default     = "arn:aws:acm:us-west-2:935064898258:certificate/8e5ec220-77d9-450f-abe9-21d5322afa78"
}

variable "aws_region" {
  description = "AWS region for the production shadow stack."
  type        = string
  default     = "us-east-2"
}

variable "api_image" {
  description = "Immutable production API image."
  type        = string
  default     = "kortix/kortix-api:0.10.14"
}

variable "gateway_image" {
  description = "Immutable production gateway image."
  type        = string
  default     = "kortix/kortix-gateway:0.10.14"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kortix.com and ACM DNS validation."
  type        = string
  default     = "af378d3df4e4dd5052a1fcbf263b685d"
}

variable "secret_arn" {
  description = "Secrets Manager ARN for the US production shadow environment."
  type        = string
}

variable "secret_keys" {
  description = "JSON keys injected from the US production shadow secret."
  type        = set(string)
}

variable "alb_ingress_cidrs" {
  description = "Cloudflare IPv4 CIDRs permitted to access the shadow ALBs."
  type        = list(string)
  default = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ]

  validation {
    condition = (
      length(var.alb_ingress_cidrs) > 0
      && !contains(var.alb_ingress_cidrs, "0.0.0.0/0")
    )
    error_message = "The shadow ALBs require a non-empty restricted CIDR allowlist."
  }
}

variable "api_shadow_hostname" {
  description = "SNI hostname used for direct shadow API verification. Terraform does not create DNS."
  type        = string
  default     = "api-use2-shadow.kortix.com"
}

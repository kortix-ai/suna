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

variable "preview_certificate_arn" {
  description = "Existing issued ACM certificate for *.preview-api.kortix.com."
  type        = string
  default     = "arn:aws:acm:us-west-2:935064898258:certificate/8e5ec220-77d9-450f-abe9-21d5322afa78"
}

variable "preview_waf_arn" {
  description = "Regional WAF associated with every public Kortix ALB."
  type        = string
  default     = "arn:aws:wafv2:us-west-2:935064898258:regional/webacl/kortix-alb-waf/4a81aadc-31ad-470a-a10c-3606de61cf65"
}

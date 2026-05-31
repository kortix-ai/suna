variable "aws_region" {
  description = "AWS region for the dev Lightsail resources."
  type        = string
  default     = "us-west-2"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kortix.com. Find with: curl -s -H \"Authorization: Bearer $TF_VAR_cloudflare_api_token\" 'https://api.cloudflare.com/client/v4/zones?name=kortix.com' | jq -r .result[0].id"
  type        = string
  default     = ""
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (the CLOUDFLARE_API_TOKEN GitHub secret). Supply via TF_VAR_cloudflare_api_token; only needed when applying the DNS module."
  type        = string
  default     = ""
  sensitive   = true
}

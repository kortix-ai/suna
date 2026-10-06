variable "aws_region" {
  description = "AWS region for staging's API/gateway stack. Colocated with the staging Supabase database (see database_region). This also makes staging match prod's topology (prod already runs eu-west-2 / eu-west-2)."
  type        = string
  default     = "eu-west-2"
}

variable "database_region" {
  description = <<-EOT
    AWS region of the staging DATABASE_URL secret (the hosted Supabase
    Postgres instance staging's API talks to). Declared explicitly,
    independent of aws_region, so
    infra/terraform/scripts/test_region_colocation.py can assert the two
    agree with no AWS credentials.

    This is the actual current region of kortix-staging-env's DATABASE_URL
    value. It does not change as part of this migration — aws_region moves
    TO it.
  EOT
  type        = string
  default     = "eu-west-2"

  validation {
    condition     = var.database_region == var.aws_region
    error_message = "staging-eu-west-2 exists to colocate the API with the database. database_region must equal aws_region here."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kortix.com. Supply via TF_VAR_cloudflare_zone_id."
  type        = string
  default     = "af378d3df4e4dd5052a1fcbf263b685d"
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
  description = "Container image for the API."
  type        = string
  default     = "kortix/kortix-api:staging-latest"
}

variable "gateway_image" {
  description = "Container image for the gateway (LLM proxy)."
  type        = string
  default     = "kortix/kortix-gateway:staging-latest"
}

variable "gateway_environment" {
  description = "Non-secret env vars for the gateway container."
  type        = map(string)
  default     = {}
}

variable "container_port" {
  description = "Port the API container listens on. Matches ../staging's 8000."
  type        = number
  default     = 8000
}

variable "api_environment" {
  description = "Non-secret env vars for the API container."
  type        = map(string)
  default     = {}
}

variable "api_secrets" {
  description = "Secret env vars: name -> Secrets Manager ARN. Empty on purpose — see ../dev-us-east-2/variables.tf's api_secrets comment; this root relies entirely on secrets_blob_arn, same as ../staging does today."
  type        = map(string)
  default     = {}
}

variable "enable_https" {
  description = "Compliance guard. Must remain true; ECS ALBs are HTTPS-only."
  type        = bool
  default     = true

  validation {
    condition     = var.enable_https
    error_message = "enable_https must remain true; ECS ALBs are HTTPS-only."
  }
}

variable "manage_dns" {
  description = <<-EOT
    Manage this stack's origin records (staging-api-euw2 /
    gateway-staging-euw2), which point at this root's ALBs. The records for
    ../staging (staging-api-ecs-fargate / gateway-staging-ecs-fargate) stay in
    ../staging.
  EOT
  type        = bool
  default     = true
}

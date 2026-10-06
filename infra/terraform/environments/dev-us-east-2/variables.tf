variable "aws_region" {
  description = "AWS region for dev's API/gateway stack. Colocated with the dev Supabase database (see database_region) so a request's 7-13 sequential DB round trips stay in-region instead of crossing a continent."
  type        = string
  default     = "us-east-2"
}

variable "database_region" {
  description = <<-EOT
    AWS region of the dev DATABASE_URL secret (the hosted Supabase Postgres
    instance dev's API talks to). Declared explicitly, independent of
    aws_region, so infra/terraform/scripts/test_region_colocation.py can
    assert the two agree with no AWS credentials: it reads both variables'
    literal defaults out of this file's source text.

    This is the actual current region of kortix-dev-env's DATABASE_URL value
    (verified via Server-Timing on the deployed API: dev db 2027ms vs prod
    19ms). It does not change as part of this migration — aws_region moves TO
    it.
  EOT
  type        = string
  default     = "us-east-2"

  validation {
    condition     = var.database_region == var.aws_region
    error_message = "dev-us-east-2 exists to colocate the API with the database. database_region must equal aws_region here; if the database ever moves, update both together."
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
  description = "Container image for the API. deploy-dev.yml supplies the freshly built kortix/kortix-api:dev-<sha8> tag at apply time (same convention as ../dev)."
  type        = string
  default     = "kortix/kortix-api:dev-latest"
}

variable "gateway_image" {
  description = "Container image for the gateway (LLM proxy)."
  type        = string
  default     = "kortix/kortix-gateway:dev-latest"
}

variable "gateway_environment" {
  description = "Non-secret env vars for the gateway container."
  type        = map(string)
  default     = {}
}

variable "container_port" {
  description = "Port the API container listens on. Matches ../dev's 8008 so the same image/task-def shape works unchanged."
  type        = number
  default     = 8008
}

variable "api_environment" {
  description = "Non-secret env vars for the API container."
  type        = map(string)
  default     = {}
}

variable "api_secrets" {
  description = <<-EOT
    Secret env vars: name -> Secrets Manager ARN. Left empty on purpose.

    ../dev commits a 67-entry literal map here, but modules/ecs-api only reads
    var.secrets when secrets_blob_arn is unset (main.tf passes
    secrets_blob_arn below, always), so that map has been INERT since it was
    written — ecs-deploy.sh wires every key from the kortix-dev-env blob
    itself at deploy time. Rather than hand-copy 67 ARNs whose account/secret
    suffix cannot be verified without AWS access (and which would silently go
    stale the next time a key is added to the secret), this root relies
    entirely on secrets_blob_arn / data.aws_secretsmanager_secret.env, same as
    ../staging already does.
  EOT
  type        = map(string)
  default     = {}
}

variable "enable_https" {
  description = "Compliance guard for the existing ACM module state address. Must remain true; ECS ALBs are HTTPS-only."
  type        = bool
  default     = true

  validation {
    condition     = var.enable_https
    error_message = "enable_https must remain true; ECS ALBs are HTTPS-only."
  }
}

variable "manage_dns" {
  description = <<-EOT
    Manage this stack's origin records (dev-api-use2 / gateway-dev-use2),
    which point at this root's ALBs. false = leave DNS untouched. The records
    for ../dev (dev-api-ecs-fargate / gateway-dev-ecs-fargate) stay in ../dev.
  EOT
  type        = bool
  default     = true
}

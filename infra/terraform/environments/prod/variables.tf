variable "aws_region" {
  description = "AWS region for the prod resources (colocated with the Supabase DB)."
  type        = string
  default     = "eu-west-2"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kortix.com. Supply via TF_VAR_cloudflare_zone_id."
  type        = string
  # The kortix.com zone id. Not a secret — it is already exposed as the
  # CLOUDFLARE_ZONE_ID repo variable and appears in every Cloudflare API URL.
  # It defaults here because an empty value resolves zone_id to null on every
  # cloudflare_record, and zone_id forces replacement: a plan run without the
  # gitignored tfvars proposed destroying and recreating live production DNS.
  default = "af378d3df4e4dd5052a1fcbf263b685d"
}

variable "extra_api_hostnames" {
  description = <<-EOT
    Additional public API hostnames to expose the ALB under (proxied CNAMEs),
    also added as ACM SANs so Cloudflare Full-strict works. Use to serve the new
    stack under an unlocked name (e.g. ["api-prod.kortix.com"]) while the
    canonical api.kortix.com record stays tunnel-locked on the old box.
  EOT
  type        = list(string)
  # This is a live SAN on the certificate currently serving api.kortix.com, so
  # it belongs in version control rather than only in a gitignored tfvars. With
  # the old default of [], any plan run without that local file — CI, or a
  # second machine — proposed REPLACING the production certificate, because
  # subject_alternative_names forces replacement.
  default = ["api-ecs-fargate.kortix.com"]
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
    production API without touching api.kortix.com. At go-live, change this back
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
  description = "Container image for the API. deploy-prod.yml supplies kortix/kortix-api:<version> at apply time."
  type        = string
  # The ONLY input this root does not carry as a committed value. deploy-prod.yml
  # passes the released tag of the run in progress (terraform-apply.yml's
  # `api_image` input -> TF_VAR_api_image), so prod always plans the immutable
  # version it is shipping. A committed pin would freeze at whatever release was
  # current the day it was written and become a landmine the next time a
  # task-definition is created from this root.
  # The default is the moving prod channel tag — deploy-prod retags every
  # release to :X.Y.Z AND :latest — so a bare `plan` (drift detection, an
  # operator laptop) resolves to a real published image. Same shape as
  # ../prod-web's web_image.
  default = "kortix/kortix-api:latest"
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
  description = "Secret env vars: name -> Secrets Manager ARN. Committed verbatim from the operator tfvars; ARNs are references, never values."
  type        = map(string)
  # Moved here verbatim from the gitignored terraform.tfvars so CI plans the
  # inputs the operator planned. These are ARNs, not secrets: the value stays in
  # Secrets Manager and only the task execution role can read it.
  #
  # Currently INERT. main.tf passes secrets_blob_arn, and modules/ecs-api reads
  # var.secrets only when that is empty (main.tf:459 for the container
  # definition, main.tf:134 for the execution-role Resource list). The map is
  # kept exact anyway so removing secrets_blob_arn cannot silently drop a key —
  # above all MANAGED_GIT_GITHUB_TOKEN (see README.md and its comment below).
  #
  # Two of the operator file's 100 keys are deliberately absent: both belong to
  # the retired hosted-deployment vendor.
  # apps/api/src/__tests__/unit-hosted-deployment-vendor-removal.test.ts forbids
  # those identifiers in any tracked file. They are dead config — no code reads
  # them — and they stay in the kortix-prod-env blob, which is what ECS injects.
  default = {
    ALLOWED_SANDBOX_PROVIDERS       = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:ALLOWED_SANDBOX_PROVIDERS::"
    ANTHROPIC_API_KEY               = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:ANTHROPIC_API_KEY::"
    API_KEY_SECRET                  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:API_KEY_SECRET::"
    AWS_BEARER_TOKEN_BEDROCK        = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:AWS_BEARER_TOKEN_BEDROCK::"
    BETTERSTACK_API_LOG_HOST        = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:BETTERSTACK_API_LOG_HOST::"
    BETTERSTACK_API_LOG_TOKEN       = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:BETTERSTACK_API_LOG_TOKEN::"
    BETTERSTACK_API_SENTRY_DSN      = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:BETTERSTACK_API_SENTRY_DSN::"
    CHANNELS_CREDENTIAL_KEY         = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:CHANNELS_CREDENTIAL_KEY::"
    CHANNELS_ENABLED                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:CHANNELS_ENABLED::"
    CHANNELS_PUBLIC_URL             = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:CHANNELS_PUBLIC_URL::"
    COMPOSIO_API_KEY                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:COMPOSIO_API_KEY::"
    COMPOSIO_WEBHOOK_SECRET         = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:COMPOSIO_WEBHOOK_SECRET::"
    CORS_ALLOWED_ORIGINS            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:CORS_ALLOWED_ORIGINS::"
    CRON_API_URL                    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:CRON_API_URL::"
    CRON_TICK_SECRET                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:CRON_TICK_SECRET::"
    DATABASE_URL                    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:DATABASE_URL::"
    DAYTONA_API_KEY                 = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:DAYTONA_API_KEY::"
    DAYTONA_SERVER_URL              = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:DAYTONA_SERVER_URL::"
    DAYTONA_SNAPSHOT                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:DAYTONA_SNAPSHOT::"
    DAYTONA_TARGET                  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:DAYTONA_TARGET::"
    ENCRYPTION_KEY                  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:ENCRYPTION_KEY::"
    ENV_MODE                        = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:ENV_MODE::"
    FIRECRAWL_API_KEY               = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:FIRECRAWL_API_KEY::"
    FRONTEND_URL                    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:FRONTEND_URL::"
    GEMINI_API_KEY                  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:GEMINI_API_KEY::"
    GROQ_API_KEY                    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:GROQ_API_KEY::"
    HETZNER_API_KEY                 = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:HETZNER_API_KEY::"
    INTEGRATION_AUTH_PROVIDER       = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:INTEGRATION_AUTH_PROVIDER::"
    INTERNAL_KORTIX_ENV             = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:INTERNAL_KORTIX_ENV::"
    INTERNAL_SERVICE_KEY            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:INTERNAL_SERVICE_KEY::"
    JUSTAVPS_API_KEY                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:JUSTAVPS_API_KEY::"
    JUSTAVPS_API_URL                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:JUSTAVPS_API_URL::"
    JUSTAVPS_DEFAULT_SERVER_TYPE    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:JUSTAVPS_DEFAULT_SERVER_TYPE::"
    JUSTAVPS_PROXY_DOMAIN           = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:JUSTAVPS_PROXY_DOMAIN::"
    JUSTAVPS_SNAPSHOT_ID            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:JUSTAVPS_SNAPSHOT_ID::"
    JUSTAVPS_WEBHOOK_SECRET         = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:JUSTAVPS_WEBHOOK_SECRET::"
    JUSTAVPS_WEBHOOK_URL            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:JUSTAVPS_WEBHOOK_URL::"
    KORTIX_ADMIN_API_KEY            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_ADMIN_API_KEY::"
    KORTIX_BILLING_INTERNAL_ENABLED = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_BILLING_INTERNAL_ENABLED::"
    KORTIX_GITHUB_APP_ID            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_GITHUB_APP_ID::"
    KORTIX_GITHUB_APP_PRIVATE_KEY   = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_GITHUB_APP_PRIVATE_KEY::"
    KORTIX_GITHUB_APP_SLUG          = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_GITHUB_APP_SLUG::"
    KORTIX_GITHUB_APP_STATE_SECRET  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_GITHUB_APP_STATE_SECRET::"
    KORTIX_GITHUB_OWNER             = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_GITHUB_OWNER::"
    KORTIX_GITHUB_TOKEN             = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_GITHUB_TOKEN::"
    KORTIX_ROUTER_INTERNAL_ENABLED  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_ROUTER_INTERNAL_ENABLED::"
    # REQUIRED for managed-git "Create project" (POST /v1/projects/provision) — the
    # org PAT used to create repos under managed-kortix. Dropping it falls back to
    # the App installation, which lacks Administration:write → 403 → 502. See prod
    # README. (Bundle key is the same value as KORTIX_GITHUB_TOKEN.)
    MANAGED_GIT_GITHUB_TOKEN      = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:MANAGED_GIT_GITHUB_TOKEN::"
    KORTIX_URL                    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_URL::"
    KORTIX_WORKERS_ENABLED        = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_WORKERS_ENABLED::"
    KORTIX_YOLO_URL               = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:KORTIX_YOLO_URL::"
    LANGFUSE_PUBLIC_KEY           = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:LANGFUSE_PUBLIC_KEY::"
    LANGFUSE_SECRET_KEY           = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:LANGFUSE_SECRET_KEY::"
    LLM_GATEWAY_ENABLED           = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:LLM_GATEWAY_ENABLED::"
    MAILTRAP_API_TOKEN            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:MAILTRAP_API_TOKEN::"
    MAILTRAP_SENDER_EMAIL         = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:MAILTRAP_SENDER_EMAIL::"
    MAILTRAP_SENDER_NAME          = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:MAILTRAP_SENDER_NAME::"
    MCP_CREDENTIAL_ENCRYPTION_KEY = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:MCP_CREDENTIAL_ENCRYPTION_KEY::"
    MORPH_API_KEY                 = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:MORPH_API_KEY::"
    NOVU_SECRET_KEY               = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:NOVU_SECRET_KEY::"
    OPENAI_API_KEY                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:OPENAI_API_KEY::"
    OPENROUTER_API_KEY            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:OPENROUTER_API_KEY::"
    PIPEDREAM_CLIENT_ID           = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:PIPEDREAM_CLIENT_ID::"
    PIPEDREAM_CLIENT_SECRET       = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:PIPEDREAM_CLIENT_SECRET::"
    PIPEDREAM_ENVIRONMENT         = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:PIPEDREAM_ENVIRONMENT::"
    PIPEDREAM_PROJECT_ID          = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:PIPEDREAM_PROJECT_ID::"
    PIPEDREAM_WEBHOOK_SECRET      = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:PIPEDREAM_WEBHOOK_SECRET::"
    POOL_ENABLED                  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:POOL_ENABLED::"
    QSTASH_CURRENT_SIGNING_KEY    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:QSTASH_CURRENT_SIGNING_KEY::"
    QSTASH_NEXT_SIGNING_KEY       = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:QSTASH_NEXT_SIGNING_KEY::"
    QSTASH_TOKEN                  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:QSTASH_TOKEN::"
    QSTASH_URL                    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:QSTASH_URL::"
    RAPID_API_KEY                 = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:RAPID_API_KEY::"
    REALITY_DEFENDER_API_KEY      = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:REALITY_DEFENDER_API_KEY::"
    REDIS_HOST                    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:REDIS_HOST::"
    REDIS_PASSWORD                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:REDIS_PASSWORD::"
    REDIS_PORT                    = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:REDIS_PORT::"
    REDIS_SSL                     = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:REDIS_SSL::"
    REDIS_USERNAME                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:REDIS_USERNAME::"
    REPLICATE_API_TOKEN           = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:REPLICATE_API_TOKEN::"
    REVENUECAT_WEBHOOK_SECRET     = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:REVENUECAT_WEBHOOK_SECRET::"
    SCHEDULER_ENABLED             = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SCHEDULER_ENABLED::"
    SERPER_API_KEY                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SERPER_API_KEY::"
    SLACK_CLIENT_ID               = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SLACK_CLIENT_ID::"
    SLACK_CLIENT_SECRET           = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SLACK_CLIENT_SECRET::"
    SLACK_OAUTH_SCOPES            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SLACK_OAUTH_SCOPES::"
    SLACK_REDIRECT_URI            = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SLACK_REDIRECT_URI::"
    SLACK_SIGNING_SECRET          = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SLACK_SIGNING_SECRET::"
    STRIPE_SECRET_KEY             = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:STRIPE_SECRET_KEY::"
    STRIPE_WEBHOOK_SECRET         = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:STRIPE_WEBHOOK_SECRET::"
    SUPABASE_ANON_KEY             = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SUPABASE_ANON_KEY::"
    SUPABASE_JWT_SECRET           = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SUPABASE_JWT_SECRET::"
    SUPABASE_SERVICE_ROLE_KEY     = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SUPABASE_SERVICE_ROLE_KEY::"
    SUPABASE_URL                  = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SUPABASE_URL::"
    SUPABASE_WEBHOOK_SECRET       = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:SUPABASE_WEBHOOK_SECRET::"
    TAVILY_API_KEY                = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:TAVILY_API_KEY::"
    TRIGGER_WEBHOOK_SECRET        = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:TRIGGER_WEBHOOK_SECRET::"
    TUNNEL_SIGNING_SECRET         = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:TUNNEL_SIGNING_SECRET::"
    XAI_API_KEY                   = "arn:aws:secretsmanager:eu-west-2:935064898258:secret:kortix-prod-env-omifd2:XAI_API_KEY::"
  }
}

variable "gateway_image" {
  description = "Container image for the gateway (LLM proxy). CI rolls new revisions; Terraform seeds the initial task-def."
  type        = string
  default     = "kortix/kortix-gateway:latest"
}

variable "gateway_environment" {
  description = "Non-secret env vars for the gateway container (besides PORT and KORTIX_API_URL, set by the module/env)."
  type        = map(string)
  default     = {}
}

variable "gateway_domain" {
  description = "FQDN for the gateway ECS origin (the Worker's ecs-fargate backend). Gets its own ACM cert. gateway.kortix.com itself stays the Worker's hostname."
  type        = string
  default     = "gateway-ecs-fargate.kortix.com"
}

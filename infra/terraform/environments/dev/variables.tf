variable "aws_region" {
  description = "AWS region for the dev resources."
  type        = string
  default     = "us-west-2"
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
  description = "Container image for the API. deploy-dev.yml supplies the freshly built kortix/kortix-api:dev-<sha8> tag at apply time."
  type        = string
  # The ONLY input this root does not carry as a committed value. deploy-dev.yml
  # passes the immutable tag the same run just published (terraform-apply.yml's
  # `api_image` input -> TF_VAR_api_image), because the tag changes on every
  # deploy and a committed pin would go stale the moment the next image ships.
  # The default is the moving dev channel tag, so a bare `plan` (drift
  # detection, an operator laptop) resolves to a real published image instead of
  # a stale landmine. Same shape as ../dev-web's web_image.
  default = "kortix/kortix-api:dev-latest"
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
  description = "Port the API container listens on. Dev binds 8008."
  type        = number
  # 8008, not the 8000 the other roots use. This is NOT cosmetic and it is the
  # reason the value had to leave the operator-only tfvars: unlike api_image it
  # never reaches the ignored container_definitions. It sets
  # aws_lb_target_group.port and both security-group rules
  # (modules/ecs-api/main.tf:212, :250, :383), and a target group's port forces
  # replacement — so a CI plan that fell back to 8000 would propose destroying
  # the live dev target group.
  default = 8008
}

variable "api_environment" {
  description = "Non-secret env vars for the API container (KORTIX_URL, DATABASE host, etc.)."
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
  # in particular MANAGED_GIT_GITHUB_TOKEN, whose absence 502s every
  # POST /v1/projects/provision (see ../prod/README.md).
  #
  # Three of the operator file's 67 keys are deliberately absent: the two for the
  # retired hosted-deployment vendor and the retired Apps experiment flag.
  # apps/api/src/__tests__/unit-hosted-deployment-vendor-removal.test.ts forbids
  # those identifiers in any tracked file. They are dead config — no code reads
  # them — and they stay in the kortix-dev-env blob, which is what ECS injects.
  default = {
    ALLOWED_SANDBOX_PROVIDERS       = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:ALLOWED_SANDBOX_PROVIDERS::"
    ANTHROPIC_API_KEY               = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:ANTHROPIC_API_KEY::"
    API_KEY_SECRET                  = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:API_KEY_SECRET::"
    BETTERSTACK_API_LOG_HOST        = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_API_LOG_HOST::"
    BETTERSTACK_API_LOG_TOKEN       = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_API_LOG_TOKEN::"
    BETTERSTACK_API_SENTRY_DSN      = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_API_SENTRY_DSN::"
    BETTERSTACK_API_TOKEN           = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_API_TOKEN::"
    BETTERSTACK_CLICKHOUSE_HOST     = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_CLICKHOUSE_HOST::"
    BETTERSTACK_CLICKHOUSE_PASSWORD = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_CLICKHOUSE_PASSWORD::"
    BETTERSTACK_CLICKHOUSE_USERNAME = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_CLICKHOUSE_USERNAME::"
    BETTERSTACK_MCP_URL             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_MCP_URL::"
    BETTERSTACK_TELEMETRY_API_TOKEN = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:BETTERSTACK_TELEMETRY_API_TOKEN::"
    CORS_ALLOWED_ORIGINS            = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:CORS_ALLOWED_ORIGINS::"
    DATABASE_URL                    = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:DATABASE_URL::"
    DAYTONA_API_KEY                 = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:DAYTONA_API_KEY::"
    DAYTONA_SERVER_URL              = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:DAYTONA_SERVER_URL::"
    DAYTONA_TARGET                  = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:DAYTONA_TARGET::"
    DAYTONA_WARM_TARGET             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:DAYTONA_WARM_TARGET::"
    E2B_API_KEY                     = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:E2B_API_KEY::"
    FIRECRAWL_API_KEY               = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:FIRECRAWL_API_KEY::"
    FRONTEND_URL                    = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:FRONTEND_URL::"
    INTEGRATION_AUTH_PROVIDER       = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:INTEGRATION_AUTH_PROVIDER::"
    INTERNAL_KORTIX_ENV             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:INTERNAL_KORTIX_ENV::"
    INTERNAL_SERVICE_KEY            = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:INTERNAL_SERVICE_KEY::"
    JUSTAVPS_API_KEY                = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:JUSTAVPS_API_KEY::"
    JUSTAVPS_API_URL                = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:JUSTAVPS_API_URL::"
    JUSTAVPS_PROXY_DOMAIN           = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:JUSTAVPS_PROXY_DOMAIN::"
    KORTIX_BILLING_INTERNAL_ENABLED = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_BILLING_INTERNAL_ENABLED::"
    KORTIX_GITHUB_APP_ID            = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_GITHUB_APP_ID::"
    KORTIX_GITHUB_APP_PRIVATE_KEY   = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_GITHUB_APP_PRIVATE_KEY::"
    KORTIX_GITHUB_APP_SLUG          = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_GITHUB_APP_SLUG::"
    KORTIX_GITHUB_APP_STATE_SECRET  = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_GITHUB_APP_STATE_SECRET::"
    KORTIX_GIT_PROXY                = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_GIT_PROXY::"
    KORTIX_URL                      = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_URL::"
    KORTIX_WARM_SNAPSHOT_ENABLED    = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_WARM_SNAPSHOT_ENABLED::"
    KORTIX_YOLO_URL                 = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:KORTIX_YOLO_URL::"
    LLM_GATEWAY_ENABLED             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:LLM_GATEWAY_ENABLED::"
    MAILTRAP_API_TOKEN              = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:MAILTRAP_API_TOKEN::"
    MAILTRAP_FROM_EMAIL             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:MAILTRAP_FROM_EMAIL::"
    MAILTRAP_FROM_NAME              = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:MAILTRAP_FROM_NAME::"
    MANAGED_GIT_GITHUB_INSTALL_ID   = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:MANAGED_GIT_GITHUB_INSTALL_ID::"
    MANAGED_GIT_GITHUB_OWNER        = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:MANAGED_GIT_GITHUB_OWNER::"
    MANAGED_GIT_GITHUB_TOKEN        = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:MANAGED_GIT_GITHUB_TOKEN::"
    OPENAI_API_KEY                  = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:OPENAI_API_KEY::"
    OPENROUTER_API_KEY              = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:OPENROUTER_API_KEY::"
    PIPEDREAM_CLIENT_ID             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:PIPEDREAM_CLIENT_ID::"
    PIPEDREAM_CLIENT_SECRET         = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:PIPEDREAM_CLIENT_SECRET::"
    PIPEDREAM_ENVIRONMENT           = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:PIPEDREAM_ENVIRONMENT::"
    PIPEDREAM_PROJECT_ID            = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:PIPEDREAM_PROJECT_ID::"
    PIPEDREAM_WEBHOOK_SECRET        = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:PIPEDREAM_WEBHOOK_SECRET::"
    REPLICATE_API_TOKEN             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:REPLICATE_API_TOKEN::"
    REVENUECAT_WEBHOOK_SECRET       = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:REVENUECAT_WEBHOOK_SECRET::"
    SERPER_API_KEY                  = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SERPER_API_KEY::"
    SLACK_CLIENT_ID                 = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SLACK_CLIENT_ID::"
    SLACK_CLIENT_SECRET             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SLACK_CLIENT_SECRET::"
    SLACK_OAUTH_SCOPES              = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SLACK_OAUTH_SCOPES::"
    SLACK_REDIRECT_URI              = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SLACK_REDIRECT_URI::"
    SLACK_SIGNING_SECRET            = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SLACK_SIGNING_SECRET::"
    STRIPE_SECRET_KEY               = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:STRIPE_SECRET_KEY::"
    STRIPE_WEBHOOK_SECRET           = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:STRIPE_WEBHOOK_SECRET::"
    SUPABASE_JWT_SECRET             = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SUPABASE_JWT_SECRET::"
    SUPABASE_SERVICE_ROLE_KEY       = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SUPABASE_SERVICE_ROLE_KEY::"
    SUPABASE_URL                    = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:SUPABASE_URL::"
    TAVILY_API_KEY                  = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:TAVILY_API_KEY::"
    TUNNEL_SIGNING_SECRET           = "arn:aws:secretsmanager:us-west-2:935064898258:secret:kortix-dev-env-otSQdL:TUNNEL_SIGNING_SECRET::"
  }
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
  description = "Manage the dev-api Cloudflare record (CNAME -> ALB). false = leave DNS untouched (no cutover)."
  type        = bool
  default     = true
}

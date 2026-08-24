variable "name" {
  description = "Name prefix for all resources (e.g. kortix-dev / kortix-prod)."
  type        = string
}

variable "aws_region" {
  description = "AWS region (used for the awslogs log driver)."
  type        = string
  default     = "us-west-2"
}

# ── Networking (from modules/network) ─────────────────────────────────────────
variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  description = "Subnets for the ALB (public)."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnets for the Fargate tasks (private; egress via NAT)."
  type        = list(string)
}

variable "assign_public_ip" {
  description = "Give tasks public IPs. Keep false when tasks run in private subnets with a NAT."
  type        = bool
  default     = false
}

# ── Container ─────────────────────────────────────────────────────────────────
variable "image" {
  description = "Container image (e.g. ghcr.io/kortix-ai/kortix-api:TAG)."
  type        = string
}

variable "container_port" {
  description = "Port the API listens on inside the container (also injected as PORT)."
  type        = number
  default     = 8000
}

variable "container_name" {
  description = "Name of the single container in the task and awslogs stream prefix."
  type        = string
  default     = "api"
}

variable "environment" {
  description = "Plain (non-secret) environment variables for the container."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret env vars: name -> Secrets Manager / SSM ARN. The execution role is granted read on these."
  type        = map(string)
  default     = {}
}

variable "health_check_path" {
  description = "HTTP path for ALB + container health checks."
  type        = string
  default     = "/health/ready"
}

# ── Sizing ────────────────────────────────────────────────────────────────────
variable "task_cpu" {
  description = "Fargate task CPU units (256/512/1024/2048/4096)."
  type        = number
  default     = 512
}

variable "deregistration_delay" {
  description = <<-EOT
    Seconds the ALB keeps draining a deregistering target.

    30 (the old hard-coded value) is fine for request/response APIs and wrong
    for anything streaming: an LLM completion routinely runs minutes, so every
    deploy, scale-in and Spot reclaim cut live turns mid-frame. The client saw a
    truncated SSE body with no error frame, which is indistinguishable from a
    model that simply stopped talking.
  EOT
  type        = number
  default     = 120
}

variable "stop_timeout" {
  description = "Seconds ECS waits after SIGTERM before SIGKILL. Must exceed the app's drain budget."
  type        = number
  default     = 120
}

variable "task_memory" {
  description = "Fargate task memory (MiB), valid for the chosen CPU."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Initial task count (autoscaling owns it afterward)."
  type        = number
  default     = 1
}

variable "min_capacity" {
  description = "Autoscaling floor. Use >= 2 in prod for HA (SOC2 availability)."
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Autoscaling ceiling."
  type        = number
  default     = 4
}

variable "cpu_target" {
  description = "Target average CPU %% for scaling."
  type        = number
  default     = 60
}

variable "memory_target" {
  description = "Target average memory %% for scaling."
  type        = number
  default     = 70
}

variable "requests_per_target_target" {
  description = <<-EOT
    Target ALBRequestCountPerTarget for request-count scaling. 0 disables it.
    CPU/memory target tracking is blind to I/O-bound stalls (during the
    2026-06-08 DB-contention incident CPU averaged ~20%% so the service never
    scaled out even while requests timed out). Scaling on requests-per-target
    adds load-proportional capacity regardless of CPU. Set per-env to the
    sustained healthy req/min/task divided by 1 (it's a per-minute target).
  EOT
  type        = number
  default     = 0
}

# ── Options ───────────────────────────────────────────────────────────────────
variable "certificate_arn" {
  description = "ACM cert ARN for the required HTTPS listener."
  type        = string

  validation {
    condition     = length(trimspace(var.certificate_arn)) > 0
    error_message = "certificate_arn is required; the ecs-api module is HTTPS-only."
  }
}

variable "use_fargate_spot" {
  description = "Run on FARGATE_SPOT (cheaper, interruptible). Good for dev; leave false in prod."
  type        = bool
  default     = false
}

variable "fargate_base_on_demand" {
  description = <<-EOT
    Number of tasks pinned to on-demand FARGATE when use_fargate_spot = true.
    Ignored when use_fargate_spot = false (that service is already all
    on-demand). 0 keeps the historic Spot-only strategy, so setting nothing
    changes nothing. Use >= 1 on any Spot environment whose total unavailability
    is a real cost: with base 0 a single Spot reclaim drops the service to zero
    tasks, and deployment_minimum_healthy_percent = 100 blocks the replacement
    until Spot capacity returns.
  EOT
  type        = number
  default     = 0

  # Must also be <= min_capacity. That is a cross-variable rule, which
  # `validation` only supports from Terraform 1.9 while this module declares
  # >= 1.5 — it is enforced as a precondition on aws_appautoscaling_target
  # instead.
  validation {
    condition     = var.fargate_base_on_demand >= 0 && floor(var.fargate_base_on_demand) == var.fargate_base_on_demand
    error_message = "fargate_base_on_demand must be a non-negative whole number."
  }
}

variable "container_insights" {
  description = "Enable CloudWatch Container Insights."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch log retention. The security baseline requires at least 365 days."
  type        = number
  default     = 365

  validation {
    condition     = var.log_retention_days >= 365
    error_message = "log_retention_days must be at least 365."
  }
}

variable "alb_idle_timeout" {
  description = "ALB idle timeout (s). Raise for long-lived/streaming requests."
  type        = number
  default     = 300
}

variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to hit the ALB. Lock to Cloudflare ranges in prod; 0.0.0.0/0 by default."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "enable_postgres_egress" {
  description = "Permit direct PostgreSQL egress on port 5432. Disable for services such as the web frontend."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "secrets_blob_arn" {
  description = <<-EOT
    ARN of the environment's Secrets Manager blob (kortix-<env>-env). The
    execution role is granted GetSecretValue on it. ECS injects the complete
    JSON document through KORTIX_ENV_JSON. This stable selector survives
    optional key additions and removals.
  EOT
  type        = string
  default     = ""
}

variable "ses_send_identity_names" {
  description = "Verified SES identity names from which this ECS task may send email. Empty disables SES task-role access."
  type        = list(string)
  default     = []
}

variable "ses_send_configuration_set_names" {
  description = "SES configuration sets the task may send through. SESv2 SendEmail authorizes against the configuration-set ARN in addition to the identity; the API's transport always sends with kortix-transactional."
  type        = list(string)
  default     = ["kortix-transactional"]
}

variable "ses_send_region" {
  description = "Region containing ses_send_identity_names. Required when SES task-role access is enabled."
  type        = string
  default     = ""

  validation {
    condition     = length(var.ses_send_identity_names) == 0 || length(trimspace(var.ses_send_region)) > 0
    error_message = "ses_send_region is required when ses_send_identity_names is not empty."
  }
}

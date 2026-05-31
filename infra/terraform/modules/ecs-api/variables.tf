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
  default     = "/v1/health"
}

# ── Sizing ────────────────────────────────────────────────────────────────────
variable "task_cpu" {
  description = "Fargate task CPU units (256/512/1024/2048/4096)."
  type        = number
  default     = 512
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

# ── Options ───────────────────────────────────────────────────────────────────
variable "certificate_arn" {
  description = "ACM cert ARN for the HTTPS listener (used when enable_https = true)."
  type        = string
  default     = ""
}

variable "enable_https" {
  description = "Create the HTTPS :443 listener (certificate_arn) and make :80 redirect to it. false = HTTP-only :80 forward. Must be a static value (gates count)."
  type        = bool
  default     = false
}

variable "use_fargate_spot" {
  description = "Run on FARGATE_SPOT (cheaper, interruptible). Good for dev; leave false in prod."
  type        = bool
  default     = false
}

variable "container_insights" {
  description = "Enable CloudWatch Container Insights."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
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

variable "tags" {
  type    = map(string)
  default = {}
}

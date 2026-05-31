variable "name" {
  description = "Name prefix for all resources (e.g. kortix-api-prod)."
  type        = string
}

variable "aws_region" {
  description = "AWS region (used for the awslogs driver)."
  type        = string
  default     = "us-west-2"
}

variable "image" {
  description = "Full container image reference, e.g. kortix/kortix-api:0.8.31."
  type        = string
}

variable "container_port" {
  description = "Port the kortix-api listens on inside the container."
  type        = number
  default     = 8008
}

# ── Networking (bring your own VPC) ──────────────────────────────────────────
variable "vpc_id" {
  description = "VPC the service + ALB live in."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets for the Fargate tasks (≥2 AZs)."
  type        = list(string)
}

variable "alb_subnet_ids" {
  description = "Public subnets for the ALB (≥2 AZs)."
  type        = list(string)
}

variable "assign_public_ip" {
  description = "Give tasks public IPs (true = public subnets, no NAT; false = private subnets + NAT)."
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS on the ALB. Empty = HTTP-only listener (dev/testing)."
  type        = string
  default     = ""
}

# ── Sizing / autoscaling ─────────────────────────────────────────────────────
variable "cpu" {
  description = "Fargate task CPU units (256,512,1024,2048,4096)."
  type        = number
  default     = 1024
}

variable "memory" {
  description = "Fargate task memory (MiB), valid pairing with cpu."
  type        = number
  default     = 2048
}

variable "desired_count" {
  description = "Initial task count."
  type        = number
  default     = 2
}

variable "min_capacity" {
  description = "Autoscaling floor (≥2 for HA across AZs)."
  type        = number
  default     = 2
}

variable "max_capacity" {
  description = "Autoscaling ceiling."
  type        = number
  default     = 10
}

variable "cpu_target_percent" {
  description = "Target-tracking CPU utilization % that scaling aims to hold."
  type        = number
  default     = 60
}

# ── App config ───────────────────────────────────────────────────────────────
variable "environment" {
  description = "Plain (non-secret) env vars for the container."
  type        = map(string)
  default     = {}
}

variable "container_secrets" {
  description = "Secret env vars: ENV_NAME => SSM Parameter or Secrets Manager ARN."
  type        = map(string)
  default     = {}
}

variable "health_check_path" {
  description = "ALB target-group health check path."
  type        = string
  default     = "/v1/health"
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}

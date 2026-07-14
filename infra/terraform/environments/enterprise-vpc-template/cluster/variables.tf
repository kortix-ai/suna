variable "aws_region" {
  type    = string
  default = "us-west-2"
}
variable "name" { type = string }
variable "expected_account_id" { type = string }
variable "vpc_cidr" { type = string }
variable "api_domain" { type = string }
variable "frontend_domain" { type = string }
variable "route53_zone_id" { type = string }
variable "release_repository_url" { type = string }
variable "tuf_root_sha256" {
  type      = string
  sensitive = true
}
variable "maintenance_window" {
  type    = string
  default = "Sun:02:00-05:00"
}
variable "operator_principal_arns" {
  type    = list(string)
  default = []
}
variable "operator_external_id" {
  type      = string
  default   = null
  sensitive = true
}
variable "permissions_boundary_arn" {
  type = string
}
# ── ECS / ALB / Bedrock / scheduler ───────────────────────────────────────────
variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to reach the public ALB. Enterprise customers should restrict this."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
variable "bedrock_model_allowlist" {
  description = "Bedrock model/inference-profile ARNs the gateway task role may invoke. Empty keeps the module default (Anthropic)."
  type        = list(string)
  default     = null
}
variable "enable_scheduled_deploy" {
  type    = bool
  default = true
}
variable "scheduler_schedule_expression" {
  type    = string
  default = "rate(1 day)"
}
variable "api_image" {
  description = "Initial API image; null seeds the placeholder and lets the deployer own revisions."
  type        = string
  default     = null
}
variable "gateway_image" {
  type    = string
  default = null
}
variable "frontend_image" {
  type    = string
  default = null
}
variable "deployer_image" {
  type    = string
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}

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
# ── Appliance / ingress / Bedrock ─────────────────────────────────────────────
variable "ingress_cidrs" {
  description = "CIDRs allowed to reach the appliance host on 80/443. Enterprise customers should restrict this."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
variable "bedrock_model_allowlist" {
  description = "Bedrock model/inference-profile ARNs the instance role may invoke. Null keeps the module default (Anthropic)."
  type        = list(string)
  default     = null
}
variable "appliance_instance_type" {
  description = "EC2 instance type for the single-box appliance. Null keeps the module default (m7i.2xlarge)."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}

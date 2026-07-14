variable "cluster_name" { type = string }
variable "aws_region" { type = string }
variable "vpc_id" { type = string }
variable "oidc_provider_arn" { type = string }
variable "oidc_provider_url" { type = string }
variable "api_domain" { type = string }
variable "frontend_domain" { type = string }
variable "route53_zone_id" { type = string }
variable "external_dns_role_arn" { type = string }
variable "app_namespace" {
  type    = string
  default = "kortix-app"
}
variable "app_service_account" {
  type    = string
  default = "kortix"
}
variable "app_irsa_role_arn" { type = string }
variable "alb_controller_role_arn" { type = string }
variable "autoscaler_role_arn" { type = string }
variable "argo_rollouts_role_arn" { type = string }
variable "permissions_boundary_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

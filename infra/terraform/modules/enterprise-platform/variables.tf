variable "cluster_name" { type = string }
variable "aws_region" { type = string }
variable "vpc_id" { type = string }
variable "oidc_provider_arn" { type = string }
variable "oidc_provider_url" { type = string }
variable "api_domain" { type = string }
variable "cloudflare_zone_id" { type = string }
variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}
variable "app_namespace" {
  type    = string
  default = "kortix-app"
}
variable "app_service_account" {
  type    = string
  default = "kortix"
}
variable "app_irsa_role_arn" { type = string }
variable "runtime_secret_arn" { type = string }
variable "permissions_boundary_arn" { type = string }
variable "argocd_domain" {
  type    = string
  default = ""
}
variable "argocd_certificate_arn" {
  type    = string
  default = ""
}
variable "tags" {
  type    = map(string)
  default = {}
}

variable "aws_region" {
  type    = string
  default = "us-west-2"
}
variable "name" { type = string }
variable "expected_account_id" { type = string }
variable "vpc_cidr" { type = string }
variable "api_domain" { type = string }
variable "frontend_domain" { type = string }
variable "release_repository_url" { type = string }
variable "tuf_root_sha256" {
  type      = string
  sensitive = true
}
variable "updater_bootstrap_url" { type = string }
variable "updater_bootstrap_sha256" {
  type      = string
  sensitive = true
}
variable "release_publisher_account_id" { type = string }
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
variable "tags" {
  type    = map(string)
  default = {}
}

variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "expected_account_id" {
  type = string
}

variable "publisher_name" {
  type    = string
  default = "kortix-enterprise-releases"
}

variable "terraform_role_name" {
  type    = string
  default = "kortix-enterprise-publisher-terraform"
}

variable "repository_bucket_name" {
  type = string
}

variable "github_oidc_provider_arn" {
  type = string
}

variable "github_repository" {
  type    = string
  default = "kortix-ai/suna"
}

variable "github_environment" {
  type    = string
  default = "enterprise-stable"
}

variable "customer_event_bus_arns" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}

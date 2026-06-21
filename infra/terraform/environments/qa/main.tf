terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 4.0, < 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# Reads CLOUDFLARE_API_TOKEN from the environment — never put the token in a file.
provider "cloudflare" {}

variable "region" {
  type    = string
  default = "us-west-2"
}

variable "cloudflare_account_id" {
  type = string
}

variable "cloudflare_zone_id" {
  type = string
}

variable "alb_hostname" {
  description = "Dev ALB DNS name for the qa ingress. Filled in Stage C after the chart is deployed."
  type        = string
  default     = ""
}

variable "manage_dns_record" {
  type    = bool
  default = false
}

module "qa_portal" {
  source = "../../modules/qa-portal"

  name        = "qa-portal"
  bucket_name = "kortix-qa-reports"
  region      = var.region

  oidc_provider_arn = "arn:aws:iam::935064898258:oidc-provider/oidc.eks.us-west-2.amazonaws.com/id/01F423916879E83FBF85E4540EA8E868"
  oidc_provider_url = "oidc.eks.us-west-2.amazonaws.com/id/01F423916879E83FBF85E4540EA8E868"

  namespace       = "kortix-qa"
  service_account = "qa-portal"

  host = "qa.kortix.com"

  manage_dns_record = var.manage_dns_record
  dns_zone_id       = var.cloudflare_zone_id
  alb_hostname      = var.alb_hostname

  enable_access                = true
  cloudflare_account_id        = var.cloudflare_account_id
  access_allowed_email_domains = ["kortix.com"]

  tags = {
    Project   = "kortix"
    Component = "qa-portal"
    ManagedBy = "terraform"
    Cluster   = "kortix-dev-eks"
  }
}

output "bucket_name" {
  value = module.qa_portal.bucket_name
}

output "role_arn" {
  value = module.qa_portal.role_arn
}

output "access_application_id" {
  value = module.qa_portal.access_application_id
}

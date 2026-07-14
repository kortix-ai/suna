data "terraform_remote_state" "cluster" {
  backend = "s3"
  config = {
    bucket         = var.state_bucket
    key            = var.cluster_state_key
    region         = var.aws_region
    dynamodb_table = var.lock_table
    encrypt        = true
    kms_key_id     = var.state_kms_key_arn
  }
}
locals {
  instance = data.terraform_remote_state.cluster.outputs.instance
}

provider "aws" { region = var.aws_region }

provider "kubernetes" {
  host                   = local.instance.cluster_endpoint
  cluster_ca_certificate = base64decode(local.instance.cluster_ca_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", local.instance.cluster_name, "--region", var.aws_region]
  }
}

provider "helm" {
  kubernetes {
    host                   = local.instance.cluster_endpoint
    cluster_ca_certificate = base64decode(local.instance.cluster_ca_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", local.instance.cluster_name, "--region", var.aws_region]
    }
  }
}

module "platform" {
  source = "../../../modules/enterprise-platform"

  cluster_name             = local.instance.cluster_name
  aws_region               = var.aws_region
  vpc_id                   = local.instance.vpc_id
  oidc_provider_arn        = local.instance.oidc_provider_arn
  oidc_provider_url        = local.instance.oidc_provider_url
  api_domain               = local.instance.api_domain
  frontend_domain          = local.instance.frontend_domain
  route53_zone_id          = local.instance.route53_zone_id
  external_dns_role_arn    = local.instance.external_dns_role_arn
  app_namespace            = local.instance.app_namespace
  app_service_account      = local.instance.app_service_account
  app_irsa_role_arn        = local.instance.app_irsa_role_arn
  alb_controller_role_arn  = local.instance.alb_controller_role_arn
  autoscaler_role_arn      = local.instance.autoscaler_role_arn
  argo_rollouts_role_arn   = local.instance.argo_rollouts_role_arn
  runtime_secret_arn       = local.instance.runtime_secret_arn
  permissions_boundary_arn = local.instance.permissions_boundary_arn
  tags                     = var.tags
}

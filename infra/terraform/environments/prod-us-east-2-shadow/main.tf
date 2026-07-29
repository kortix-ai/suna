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
  region = var.aws_region
}

locals {
  name = "kortix-prod-use2"
  tags = {
    Environment = "prod-use2-shadow"
    Project     = "kortix"
    ManagedBy   = "terraform"
  }
  secrets = {
    for key in var.secret_keys :
    key => "${var.secret_arn}:${key}::"
  }
}

module "network" {
  source = "../../modules/network"

  name               = local.name
  cidr               = "10.40.0.0/16"
  az_count           = 2
  single_nat_gateway = false
  tags               = local.tags

  # compliance-monitoring owns this VPC's default NACL (aws_default_network_acl.use2)
  # and points its subnets at aws_network_acl.use2_restricted. Adopting it here too
  # would make the two roots overwrite each other on every apply.
  manage_default_network_acl = false
}

module "certificate" {
  source = "../../modules/acm-cloudflare"

  domain_name               = "*.kortix.com"
  subject_alternative_names = ["kortix.com"]
  manage_validation_records = false
  zone_id                   = var.cloudflare_zone_id
  tags = merge(local.tags, {
    Platform = "ecs"
    Service  = "certificate"
  })
}

module "api" {
  source = "../../modules/ecs-api"

  name       = local.name
  aws_region = var.aws_region

  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  image             = var.api_image
  container_name    = "api"
  container_port    = 8000
  health_check_path = "/v1/health"
  certificate_arn   = module.certificate.certificate_arn
  environment = {
    KORTIX_VERSION = "0.10.14"
  }
  secrets = local.secrets

  alb_ingress_cidrs = var.alb_ingress_cidrs

  task_cpu           = 1024
  task_memory        = 2048
  desired_count      = 2
  min_capacity       = 2
  max_capacity       = 10
  use_fargate_spot   = false
  container_insights = true
  cpu_target         = 55
  memory_target      = 65

  requests_per_target_target = 600
  tags = merge(local.tags, {
    Service = "kortix-api"
  })
}

module "gateway" {
  source = "../../modules/ecs-api"

  name       = "${local.name}-gateway"
  aws_region = var.aws_region

  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  image             = var.gateway_image
  container_name    = "gateway"
  container_port    = 8090
  health_check_path = "/health/live"
  certificate_arn   = module.certificate.certificate_arn
  environment = {
    KORTIX_API_URL = "https://${var.api_shadow_hostname}"
    KORTIX_VERSION = "0.10.14"
  }
  secrets = local.secrets

  alb_ingress_cidrs = var.alb_ingress_cidrs

  task_cpu           = 512
  task_memory        = 1024
  desired_count      = 2
  min_capacity       = 2
  max_capacity       = 6
  use_fargate_spot   = false
  container_insights = true
  cpu_target         = 55
  memory_target      = 65

  tags = merge(local.tags, {
    Service = "kortix-gateway"
  })
}

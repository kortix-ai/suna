# ── prod environment — api.kortix.com on ECS Fargate (autoscaled, HA) ─────────
#
#   api.kortix.com → Cloudflare (proxied, Full strict) → ALB → ECS Fargate
#   service (autoscaled on CPU/memory, min 2 tasks across 2 AZs) in private
#   subnets, egress via per-AZ NAT.
#
# SAME modules as dev (../dev) — prod just runs bigger numbers, no Spot, a NAT
# per AZ, and Container Insights on. min_capacity=2 across AZs gives the
# availability + horizontal autoscaling expected for SOC 2. Not applied
# automatically. See README.md.

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

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  name   = "kortix-prod"
  domain = "api.kortix.com"
  tags = {
    Environment = "prod"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr               = "10.20.0.0/16"
  az_count           = 2
  single_nat_gateway = false # prod: NAT per AZ for HA
  tags               = local.tags
}

module "acm" {
  source      = "../../modules/acm-cloudflare"
  domain_name = local.domain
  zone_id     = var.cloudflare_zone_id
  tags        = local.tags
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

module "api" {
  source     = "../../modules/ecs-api"
  name       = local.name
  aws_region = var.aws_region

  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  image           = var.api_image
  container_port  = var.container_port
  certificate_arn = module.acm.certificate_arn
  environment     = var.api_environment
  secrets         = var.api_secrets

  # prod sizing: bigger tasks, HA floor of 2, no spot, insights on
  task_cpu           = 1024
  task_memory        = 2048
  desired_count      = 2
  min_capacity       = 2
  max_capacity       = 10
  use_fargate_spot   = false
  container_insights = true
  cpu_target         = 55
  memory_target      = 65
  tags               = local.tags
}

module "dns" {
  source  = "../../modules/cloudflare-dns"
  zone_id = var.cloudflare_zone_id

  records = {
    api = {
      name    = "api"
      type    = "CNAME"
      value   = module.api.alb_dns_name
      proxied = true
      ttl     = 1
    }
  }
}

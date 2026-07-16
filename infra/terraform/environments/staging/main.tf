# ── staging environment — ECS Fargate (api + gateway), autoscaled ─────────────
#
#   staging-api-ecs-fargate.kortix.com  → Cloudflare (proxied, Full strict) → ALB
#   gateway-staging-ecs-fargate.kortix.com → Cloudflare → ALB → gateway service
#
# These are the ECS backends the `api-router` Worker (env=staging) routes to via
# its ACTIVE_BACKEND / GATEWAY_ACTIVE_BACKEND toggles; staging-api.kortix.com and
# gateway-staging.kortix.com are the Worker's route/custom-domain hostnames and
# are NOT managed here. Same module set as dev/prod.
#
# To avoid a Cloudflare dependency at apply time, this env uses the *.kortix.com
# wildcard ACM cert directly (no per-host module.acm) and leaves DNS records to be
# created out-of-band (manage_dns=false); the wildcard already passes CF Full(strict).

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
  # Only used if manage_dns=true; a format-valid dummy token lets pure-AWS applies
  # run with no Cloudflare creds.
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : (var.cloudflare_api_key != "" ? null : "0000000000000000000000000000000000000000")
  email     = var.cloudflare_api_key != "" ? var.cloudflare_email : null
  api_key   = var.cloudflare_api_key != "" ? var.cloudflare_api_key : null
}

locals {
  name = "kortix-staging"
  cloudflare_ip_ranges = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
  tags = {
    Environment = "staging"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

# ── Network (VPC + public/private subnets + NAT) ──────────────────────────────
module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr               = "10.20.0.0/16" # distinct from dev (10.10) / prod
  az_count           = 2
  single_nat_gateway = true # staging: one NAT to save cost
  tags               = local.tags
}

# ── ECS Fargate API service (autoscaled) ──────────────────────────────────────
module "api" {
  source     = "../../modules/ecs-api"
  name       = local.name
  aws_region = var.aws_region

  vpc_id = module.network.vpc_id
  public_subnet_ids = [
    module.network.public_subnet_ids[0],
    module.network.public_subnet_ids[1],
  ]
  private_subnet_ids = module.network.private_subnet_ids

  image           = var.api_image
  container_port  = var.container_port
  enable_https    = var.enable_https
  certificate_arn = var.enable_https ? var.wildcard_certificate_arn : ""
  environment     = var.api_environment
  secrets         = var.api_secrets

  alb_ingress_cidrs = local.cloudflare_ip_ranges

  # staging sizing: small + spot, floor of 1 (release-candidate lane)
  task_cpu                   = 512
  task_memory                = 1024
  desired_count              = 1
  min_capacity               = 1
  max_capacity               = 3
  use_fargate_spot           = true
  requests_per_target_target = 600
  tags                       = local.tags
}

# ── Gateway (LLM proxy) as its own ECS Fargate service ────────────────────────
module "gateway" {
  source     = "../../modules/ecs-api"
  name       = "${local.name}-gateway"
  aws_region = var.aws_region

  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  image             = var.gateway_image
  container_name    = "gateway"
  container_port    = 8090
  health_check_path = "/health/live"
  enable_https      = var.enable_https
  certificate_arn   = var.enable_https ? var.wildcard_certificate_arn : ""
  environment       = merge(var.gateway_environment, { KORTIX_API_URL = "https://staging-api.kortix.com" })
  secrets           = var.api_secrets

  alb_ingress_cidrs = local.cloudflare_ip_ranges

  task_cpu         = 256
  task_memory      = 512
  desired_count    = 1
  min_capacity     = 1
  max_capacity     = 3
  use_fargate_spot = true
  tags             = local.tags
}

# ── DNS (optional; default off — records created out-of-band) ─────────────────
module "dns" {
  source  = "../../modules/cloudflare-dns"
  count   = var.manage_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id

  records = {
    staging-api-ecs-fargate = {
      name    = "staging-api-ecs-fargate"
      type    = "CNAME"
      value   = module.api.alb_dns_name
      proxied = true
      ttl     = 1
    }
    gateway-staging-ecs-fargate = {
      name    = "gateway-staging-ecs-fargate"
      type    = "CNAME"
      value   = module.gateway.alb_dns_name
      proxied = true
      ttl     = 1
    }
  }
}

# ── dev environment — dev-api-ecs-fargate.kortix.com (ECS Fargate, autoscaled) ─
#
#   dev-api-ecs-fargate.kortix.com → Cloudflare (proxied, Full strict) → ALB →
#   ECS Fargate service (autoscaled) in private subnets, egress via NAT.
#   dev.kortix.com (frontend) stays on Vercel — not managed here.
#
# This ECS service is the always-warm FALLBACK behind dev-api.kortix.com: that
# hostname is a Cloudflare Worker (infra/cloudflare/workers/api-router, env=dev)
# that routes to EKS (dev-api-eks, primary) or here (dev-api-ecs-fargate) via its
# ACTIVE_BACKEND var. So this stack owns the dev-api-ecs-fargate name ONLY —
# dev-api itself is the Worker's custom domain, NOT managed here.
#
# Same module set prod uses (../prod) — dev just runs smaller numbers + Fargate
# Spot. App code ships via CI (deploy-dev rolls this in parallel with EKS).
# Nothing here is applied automatically. See README.md.
#
# NOTE: live was bootstrapped out-of-band (standalone ACM cert + manual proxied
# CNAME via the Cloudflare API while EKS was made primary); a `terraform apply`
# here reconciles onto this config — the old dev-api record is now the Worker's
# and must NOT be recreated (hence local.domain below is the -ecs-fargate name).

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
  # Auth precedence: scoped API token → global API key (email+key) → format-valid
  # dummy token (so HTTP-only applies with no creds don't reject an empty token).
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : (var.cloudflare_api_key != "" ? null : "0000000000000000000000000000000000000000")
  email     = var.cloudflare_api_key != "" ? var.cloudflare_email : null
  api_key   = var.cloudflare_api_key != "" ? var.cloudflare_api_key : null
}

locals {
  name   = "kortix-dev"
  domain = "dev-api-ecs-fargate.kortix.com" # the ECS fallback name; dev-api itself is the Worker's custom domain
  tags = {
    Environment = "dev"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

# ── Network (VPC + public/private subnets + NAT) ──────────────────────────────
module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr               = "10.10.0.0/16"
  az_count           = 2
  single_nat_gateway = true # dev: one NAT to save cost
  tags               = local.tags
}

# ── TLS cert (ACM, validated via Cloudflare DNS) ──────────────────────────────
module "acm" {
  source      = "../../modules/acm-cloudflare"
  count       = var.enable_https ? 1 : 0
  domain_name = local.domain
  zone_id     = var.cloudflare_zone_id
  tags        = local.tags
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

# ── ECS Fargate API service (autoscaled) ──────────────────────────────────────
module "api" {
  source     = "../../modules/ecs-api"
  name       = local.name
  aws_region = var.aws_region

  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  image           = var.api_image
  container_port  = var.container_port
  enable_https    = var.enable_https
  certificate_arn = var.enable_https ? one(module.acm[*].certificate_arn) : ""
  environment     = var.api_environment
  secrets         = var.api_secrets

  # dev sizing: small + spot, floor of 1
  task_cpu         = 512
  task_memory      = 1024
  desired_count    = 1
  min_capacity     = 1
  max_capacity     = 3
  use_fargate_spot = true
  # Validate the request-count scaling policy here before prod. Low traffic, so
  # this rarely triggers; primarily exercises the Terraform path.
  requests_per_target_target = 600
  tags                       = local.tags
}

# ── DNS: dev-api-ecs-fargate.kortix.com → the ALB (Cloudflare-proxied) ─────────
# This is the ECS fallback backend the dev-api Worker routes to. dev-api itself
# is the Worker's custom domain (AAAA 100:: placeholder) and is intentionally NOT
# managed here, so a terraform apply never clobbers the Worker.
module "dns" {
  source  = "../../modules/cloudflare-dns"
  count   = var.manage_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id

  records = {
    dev-api-ecs-fargate = {
      name    = "dev-api-ecs-fargate"
      type    = "CNAME"
      value   = module.api.alb_dns_name
      proxied = true
      ttl     = 1
    }
  }
}

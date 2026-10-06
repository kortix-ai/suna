# ── staging-web-eu-west-2 — staging's ECS web service in eu-west-2 ──────────
#
# Copy of ../staging-web in eu-west-2, next to ../staging-eu-west-2 and the
# staging database. It reads that root's VPC (kortix-staging-euw2-vpc) and the
# secret kortix-staging-euw2-web-env in eu-west-2. Its origin hostname is
# staging-fe-ecs-euw2.kortix.com. staging-fe-ecs.kortix.com points at
# ../staging-web until the switch-over in ../staging-eu-west-2/README.md.

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
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : "0000000000000000000000000000000000000000"
}

locals {
  name = "kortix-staging-euw2-web"
  cloudflare_ip_ranges = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
  tags = {
    Environment = "staging"
    Region      = "eu-west-2"
    Service     = "kortix-web"
    ManagedBy   = "terraform"
  }
}

data "aws_vpc" "staging" {
  filter {
    name   = "tag:Name"
    values = ["kortix-staging-euw2-vpc"]
  }
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.staging.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["public"]
  }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.staging.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["private"]
  }
}

data "aws_secretsmanager_secret" "web_env" {
  name = "kortix-staging-euw2-web-env"
}

data "aws_wafv2_web_acl" "regional" {
  name  = "kortix-alb-waf"
  scope = "REGIONAL"
}

# One certificate for the live hostname and the origin hostname, so the same
# ALB serves before and after the switch-over (Cloudflare Full strict checks
# the name it connects with).
module "certificate" {
  source                    = "../../modules/acm-cloudflare"
  domain_name               = "staging-fe-ecs.kortix.com"
  subject_alternative_names = ["staging-fe-ecs-euw2.kortix.com"]
  zone_id                   = var.cloudflare_zone_id
  tags                      = merge(local.tags, { Service = "certificate" })
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

module "web" {
  source     = "../../modules/ecs-api"
  name       = local.name
  aws_region = var.aws_region

  vpc_id             = data.aws_vpc.staging.id
  public_subnet_ids  = sort(data.aws_subnets.public.ids)
  private_subnet_ids = sort(data.aws_subnets.private.ids)

  image                  = var.web_image
  container_name         = "web"
  container_port         = 3000
  health_check_path      = "/api/health"
  certificate_arn        = module.certificate.certificate_arn
  secrets_blob_arn       = data.aws_secretsmanager_secret.web_env.arn
  alb_ingress_cidrs      = local.cloudflare_ip_ranges
  enable_postgres_egress = false

  task_cpu         = 512
  task_memory      = 1024
  desired_count    = 1
  min_capacity     = 1
  max_capacity     = 4
  use_fargate_spot = false
  tags             = local.tags
}

resource "aws_wafv2_web_acl_association" "web" {
  resource_arn = module.web.alb_arn
  web_acl_arn  = data.aws_wafv2_web_acl.regional.arn
}

module "dns" {
  source  = "../../modules/cloudflare-dns"
  count   = var.manage_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id

  records = {
    staging-fe-ecs-euw2 = {
      name    = "staging-fe-ecs-euw2"
      type    = "CNAME"
      value   = module.web.alb_dns_name
      proxied = true
      ttl     = 1
      comment = "Kortix staging frontend origin in eu-west-2"
    }
  }
}

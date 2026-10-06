# ── dev-web-us-east-2 — dev's ECS web service in us-east-2 ──────────────────
#
# Copy of ../dev-web in us-east-2, next to ../dev-us-east-2 and the dev
# database. It reads that root's VPC (kortix-dev-use2-vpc) and the secret
# kortix-dev-use2-web-env in us-east-2. Its origin hostname is
# dev-use2.kortix.com. dev.kortix.com points at ../dev-web until the
# switch-over in ../dev-us-east-2/README.md.

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
  name = "kortix-dev-use2-web"
  cloudflare_ip_ranges = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
  tags = {
    Environment = "dev"
    Region      = "us-east-2"
    Service     = "kortix-web"
    ManagedBy   = "terraform"
  }
}

data "aws_vpc" "dev" {
  filter {
    name   = "tag:Name"
    values = ["kortix-dev-use2-vpc"]
  }
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.dev.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["public"]
  }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.dev.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["private"]
  }
}

data "aws_secretsmanager_secret" "web_env" {
  name = "kortix-dev-use2-web-env"
}

data "aws_wafv2_web_acl" "regional" {
  name  = "kortix-alb-waf"
  scope = "REGIONAL"
}

# *.kortix.com covers both dev.kortix.com and dev-use2.kortix.com, so the same
# certificate serves before and after the switch-over. Its validation record is
# already in the zone (same reason as ../dev-us-east-2's module.certificate).
module "certificate" {
  source                    = "../../modules/acm-cloudflare"
  domain_name               = "*.kortix.com"
  subject_alternative_names = ["kortix.com"]
  manage_validation_records = false
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

  vpc_id             = data.aws_vpc.dev.id
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
  use_fargate_spot = true
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
    dev-use2 = {
      name    = "dev-use2"
      type    = "CNAME"
      value   = module.web.alb_dns_name
      proxied = true
      ttl     = 1
      comment = "Kortix dev frontend origin in us-east-2"
    }
  }
}

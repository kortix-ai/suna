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
  name = "kortix-dev-web"
  cloudflare_ip_ranges = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
  tags = {
    Environment = "dev"
    Service     = "kortix-web"
    ManagedBy   = "terraform"
  }
}

data "aws_vpc" "dev" {
  filter {
    name   = "tag:Name"
    values = ["kortix-dev-vpc"]
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
  name = "kortix-dev-web-env"
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
  certificate_arn        = var.web_certificate_arn
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

module "dns" {
  source  = "../../modules/cloudflare-dns"
  count   = var.manage_origin_dns || var.manage_canonical_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id

  records = merge(
    var.manage_origin_dns ? {
      dev-web-ecs-fargate = {
        name    = "dev-web-ecs-fargate"
        type    = "CNAME"
        value   = module.web.alb_dns_name
        proxied = true
        ttl     = 1
      }
    } : {},
    var.manage_canonical_dns ? {
      dev = {
        name    = "dev"
        type    = "CNAME"
        value   = module.web.alb_dns_name
        proxied = true
        ttl     = 1
      }
    } : {},
  )
}

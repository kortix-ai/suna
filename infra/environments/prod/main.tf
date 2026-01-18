terraform {
  # Use local state for now - switch to Terraform Cloud after VCS connection
  backend "local" {
    path = "terraform.tfstate"
  }
  
  # Uncomment this after connecting Terraform Cloud to GitHub (VCS-driven workflow)
  # cloud {
  #   organization = "kortix"
  #   workspaces {
  #     name = "suna-prod"
  #   }
  # }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = "us-west-2"
}

provider "cloudflare" {
  # Use Global API Key + Email (legacy method)
  api_key = var.cloudflare_api_key
  email   = var.cloudflare_email
}

# Lightsail Instance
module "lightsail" {
  source            = "../../modules/lightsail"
  instance_name     = "suna-prod"
  bundle_id         = "8xlarge_3_0"
  blueprint_id      = "ubuntu_24_04"
  availability_zone = "us-west-2a"
  key_pair_name     = "suna-prod-key"
  create_static_ip  = true
  static_ip_name    = "StaticIp-2"  # Use existing static IP
  tags = {
    Environment = "prod"
    Project     = "suna"
    Name        = "suna-prod"
    "map-migrated" = "migDTKWJGT6A7"
  }
}

# VPC
module "vpc" {
  source            = "../../modules/vpc"
  vpc_name         = "suna-vpc"
  vpc_cidr         = "10.20.0.0/16"
  create_redis_sg  = true  # Re-enabled - will import existing SG
  tags = {
    "map-migrated" = "migDTKWJGT6A7"
  }
}

# ALB
module "alb" {
  source              = "../../modules/alb"
  alb_name            = "suna-alb-3975a7d"
  vpc_id              = module.vpc.vpc_id
  public_subnet_ids   = module.vpc.public_subnet_ids
  security_group_id   = module.vpc.alb_security_group_id
  target_group_name   = "suna-api-tg-2ca3a58"
  certificate_arn     = var.acm_certificate_arn
  enable_deletion_protection = false
  tags = {
    "map-migrated" = "migDTKWJGT6A7"
  }
}

# ECS
module "ecs" {
  source              = "../../modules/ecs"
  cluster_name        = "suna-ecs"
  instance_type       = "r6a.xlarge"
  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  ecs_security_group_id = module.vpc.ecs_tasks_security_group_id
  target_group_arn    = module.alb.target_group_arn
  min_size            = 2
  max_size            = 8
  desired_capacity    = 3
  service_desired_count = 4
  service_base_count  = 2
  container_image     = var.container_image
  use_aws_redis       = false # Using Upstash
  secrets_arn         = var.secrets_arn
  tags = {
    "map-migrated" = "migDTKWJGT6A7"
  }
}

# Cloudflare Tunnel (Lightsail)
module "tunnel_lightsail" {
  source      = "../../modules/cloudflare-tunnel"
  account_id  = var.cloudflare_account_id
  tunnel_name = "PRODUCTION API Lightsail"
  tunnel_secret = null # Will be generated

  ingress_rules = [
    {
      hostname = "api.kortix.com"
      service  = "http://localhost:8000"
      origin_request = null
    },
    {
      hostname = "api-lightsail.kortix.com"
      service  = "http://localhost:8000"
      origin_request = {}
    }
  ]
}

# Cloudflare Worker (Router)
module "worker" {
  source         = "../../modules/cloudflare-worker"
  account_id     = var.cloudflare_account_id
  zone_id        = var.cloudflare_zone_id
  worker_name    = "api-kortix-router"
  hostname       = "api.kortix.com"
  active_backend = var.active_backend
}

# DNS Records
module "dns" {
  source  = "../../modules/cloudflare-dns"
  zone_id = var.cloudflare_zone_id

  records = {
    "api-ecs" = {
      name    = "api-ecs"  # Just subdomain
      type    = "CNAME"
      value   = module.alb.alb_dns_name
      proxied = false
      ttl     = 1
      comment = "ECS ALB endpoint"
    }
    "api-lightsail" = {
      name    = "api-lightsail"  # Just subdomain
      type    = "CNAME"
      value   = "${module.tunnel_lightsail.tunnel_id}.cfargotunnel.com"
      proxied = true
      ttl     = 1
      comment = "Lightsail tunnel endpoint"
    }
  }
}

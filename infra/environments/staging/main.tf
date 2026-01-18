terraform {
  # Use local state for now - switch to Terraform Cloud after VCS connection
  backend "local" {
    path = "terraform.tfstate"
  }
  
  # Uncomment this after connecting Terraform Cloud to GitHub (VCS-driven workflow)
  # cloud {
  #   organization = "kortix"
  #   workspaces {
  #     name = "suna-staging"
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
  instance_name     = "suna-staging"
  bundle_id         = "large_3_0"
  blueprint_id      = "ubuntu_24_04"
  availability_zone = "us-west-2a"
  key_pair_name     = "suna-staging-key"
  create_static_ip  = true
  static_ip_name    = "StaticIp-1"  # Use existing static IP
  tags = {
    Environment = "staging"
    Project     = "suna"
    Name        = "suna-staging"
    "map-migrated" = "migDTKWJGT6A7"
  }
}

# Cloudflare Tunnel
module "tunnel" {
  source      = "../../modules/cloudflare-tunnel"
  account_id  = var.cloudflare_account_id
  tunnel_name = "STAGING API Lightsail"
  tunnel_secret = null # Will be generated

  ingress_rules = [
    {
      hostname = "staging-api.kortix.com"
      service  = "http://localhost:8000"
      origin_request = {}
    },
    {
      hostname = "staging-api.suna.so"
      service  = "http://localhost:8000"
      origin_request = {}
    }
  ]
}

# DNS Records for Tunnel (kortix.com)
module "dns_kortix" {
  source  = "../../modules/cloudflare-dns"
  zone_id = var.cloudflare_zone_id

  records = {
    "staging-api-kortix" = {
      name    = "staging-api"  # Just subdomain
      type    = "CNAME"
      value   = "${module.tunnel.tunnel_id}.cfargotunnel.com"
      proxied = true
      ttl     = 1
      comment = "Staging API tunnel (kortix.com)"
    }
  }
}

# DNS Records for Tunnel (suna.so)
module "dns_suna" {
  source  = "../../modules/cloudflare-dns"
  zone_id = var.cloudflare_zone_id_suna

  records = {
    "staging-api-suna" = {
      name    = "staging-api"  # Just subdomain for suna.so zone
      type    = "CNAME"
      value   = "${module.tunnel.tunnel_id}.cfargotunnel.com"
      proxied = true
      ttl     = 1
      comment = "Staging API tunnel (suna.so)"
    }
  }
}

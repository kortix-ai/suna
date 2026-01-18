terraform {
  # Use local state for now - switch to Terraform Cloud after VCS connection
  backend "local" {
    path = "terraform.tfstate"
  }
  
  # Uncomment this after connecting Terraform Cloud to GitHub (VCS-driven workflow)
  # cloud {
  #   organization = "kortix"
  #   workspaces {
  #     name = "suna-dev"
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
  instance_name     = "suna-dev"
  bundle_id         = "large_3_0"
  blueprint_id      = "ubuntu_24_04"
  availability_zone = "us-west-2a"
  key_pair_name     = "LightsailDefaultKeyPair" # Actual key on instance
  create_static_ip  = false # Dev doesn't have static IP
  tags = {
    Environment = "dev"
    Project     = "suna"
    Name        = "suna-dev"
    "map-migrated" = "migDTKWJGT6A7"
  }
}

# Cloudflare Tunnel
module "tunnel" {
  source      = "../../modules/cloudflare-tunnel"
  account_id  = var.cloudflare_account_id
  tunnel_name = "DEVELOPMENT API Lightsail"
  tunnel_secret = null # Will be generated

  ingress_rules = [
    {
      hostname = "dev-api.kortix.com"
      service  = "http://localhost:8000"
      origin_request = null
    }
  ]
}

# DNS Record for Tunnel
module "dns" {
  source  = "../../modules/cloudflare-dns"
  zone_id = var.cloudflare_zone_id

  records = {
    "dev-api" = {
      name    = "dev-api"  # Just the subdomain, zone is kortix.com
      type    = "CNAME"
      value   = "${module.tunnel.tunnel_id}.cfargotunnel.com"
      proxied = true
      ttl     = 1
      comment = "Dev API tunnel"
    }
  }
}

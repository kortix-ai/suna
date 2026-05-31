# ── dev environment ──────────────────────────────────────────────────────────
# The full dev.kortix.com / dev-api.kortix.com surface, as code.
#
#   • dev-api.kortix.com → Lightsail box "kortix-dev" (us-west-2) behind nginx
#     (blue/green 8008/8009), fronted by a proxied Cloudflare DNS record.
#   • dev.kortix.com → Vercel (its own Git integration / DNS) — NOT managed here.
#
# This config ADOPTS the existing live resources via import (see import.sh); it
# never recreates the running box or repoints live DNS on first apply.

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

# Token from TF_VAR_cloudflare_api_token (the CLOUDFLARE_API_TOKEN GitHub
# secret). Only needed for the DNS module; AWS-only runs can leave it empty.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ── Compute: the API host ────────────────────────────────────────────────────
module "api_host" {
  source = "../../modules/api-host"

  instance_name     = "kortix-dev"
  availability_zone = "us-west-2a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "small_3_0"
  key_pair_name     = "kortix-lightsail"
  manage_static_ip  = true
  static_ip_name    = "kortix-dev-ip"

  tags = {
    Environment = "dev"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

# ── DNS: dev-api.kortix.com → the box (Cloudflare-proxied) ────────────────────
module "dns" {
  source  = "../../modules/cloudflare-dns"
  zone_id = var.cloudflare_zone_id

  records = {
    dev-api = {
      name    = "dev-api"
      type    = "A"
      value   = module.api_host.public_ip
      proxied = true # orange-cloud: CF terminates TLS, nginx uses the CF origin cert
      ttl     = 1    # must be 1 (automatic) when proxied
    }
  }
}

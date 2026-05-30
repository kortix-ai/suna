# ── dev environment ──────────────────────────────────────────────────────────
# dev-api.kortix.com — the Lightsail box "kortix-dev" in us-west-2.
# Adopts the existing live instance (see import.sh); does not recreate it.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "api_host" {
  source = "../../modules/api-host"

  instance_name     = "kortix-dev"
  availability_zone = "us-west-2a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "small_3_0"
  key_pair_name     = "kortix-lightsail"
  static_ip_name    = "kortix-dev-ip"

  tags = {
    Environment = "dev"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

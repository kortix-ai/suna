# ── prod environment ─────────────────────────────────────────────────────────
# api.kortix.com — the Lightsail box "kortix-prod-xlarge-20260401" in us-west-2.
# Adopts the existing live instance (see import.sh); does not recreate it.
#
# NOTE: this codifies the CURRENT hand-managed prod box so prod is reproducible
# today. The SOC2 autoscaling target (ECS Fargate + ALB) lives in the separate
# `ecs-api` module and is applied as a deliberate migration, not from here.

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

  instance_name     = "kortix-prod-xlarge-20260401"
  availability_zone = "us-west-2a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "xlarge_3_0"
  key_pair_name     = "kortix-lightsail"
  manage_static_ip  = false # prod rides the instance's plain public IP

  tags = {
    Environment = "prod"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

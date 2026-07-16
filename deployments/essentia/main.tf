# deployments/essentia — Essentia's single-tenant self-host box at
# essentia.kortix.cloud, provisioned by infra/terraform/modules/selfhost-ec2
# into ESSENTIA'S OWN AWS account (327903111249 — apply with
# AWS_PROFILE=essentia), not the Kortix account. Mirrors deployments/vps-demo.
#
# DNS is manual-mode on purpose (no zone_id): the essentia.kortix.cloud /
# api.essentia.kortix.cloud A records live in the Cloudflare kortix.cloud zone
# (DNS-only/unproxied so ACME HTTP-01 works) and are created by the operator
# from the module's post_apply_next_steps output — their AWS account has no
# Route53 zone for this.
#
# State is LOCAL (backend.tf) — a single customer box, not a shared
# environment; terraform.tfstate is gitignored and lives on whichever machine
# ran `apply`.
#
#   cd deployments/essentia
#   AWS_PROFILE=essentia terraform init
#   AWS_PROFILE=essentia terraform apply

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

module "essentia" {
  source = "../../infra/terraform/modules/selfhost-ec2"

  name        = "essentia-selfhost"
  domain      = var.domain
  admin_email = var.admin_email

  instance_type = var.instance_type

  data_volume_size_gb    = var.data_volume_size_gb
  backup_interval_hours  = var.backup_interval_hours
  backup_retention_count = var.backup_retention_count

  kortix_channel     = var.kortix_channel
  kortix_version     = var.kortix_version
  kortix_cli_channel = var.kortix_cli_channel
  auto_update        = var.auto_update

  tags = {
    Project        = "kortix-selfhost"
    Environment    = "essentia"
    KortixInstance = "essentia"
    ManagedBy      = "terraform"
  }
}

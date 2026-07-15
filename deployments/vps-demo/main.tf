# deployments/vps-demo — the live vps-demo.kortix.com demo box, provisioned
# by infra/terraform/modules/selfhost-ec2. Replaces the retired
# deployments/vpc-demo (vpc-demo.kortix.com) — full teardown + fresh
# from-scratch deploy under the new name, see git log for the migration
# notes.
#
# State is LOCAL (backend.tf) — this is a single demo box, not a shared
# environment; state lives at deployments/vps-demo/terraform.tfstate on
# whichever machine ran `apply` and is gitignored (never commit it). If this
# needs to become a team-shared environment later, move it to the standard
# kortix-terraform-state S3 backend used by infra/terraform/environments/*.
#
#   cd deployments/vps-demo
#   cp terraform.tfvars.example terraform.tfvars   # already filled in for this deploy
#   terraform init
#   terraform apply

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

module "vps_demo" {
  source = "../../infra/terraform/modules/selfhost-ec2"

  name        = "vps-demo-selfhost"
  domain      = var.domain
  zone_id     = var.route53_zone_id
  admin_email = var.admin_email

  instance_type = var.instance_type
  vpc_id        = var.vpc_id
  subnet_id     = var.subnet_id

  data_volume_size_gb    = var.data_volume_size_gb
  backup_interval_hours  = var.backup_interval_hours
  backup_retention_count = var.backup_retention_count

  kortix_channel     = var.kortix_channel
  kortix_version     = var.kortix_version
  kortix_cli_channel = var.kortix_cli_channel
  auto_update        = var.auto_update

  tags = {
    Project        = "kortix-selfhost"
    Environment    = "demo"
    KortixInstance = "vps-demo"
    ManagedBy      = "terraform"
  }
}

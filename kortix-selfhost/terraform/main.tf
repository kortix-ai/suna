# kortix-selfhost/terraform — AWS/EC2 provisioner for Kortix self-host.
#
# This is a THIN root module: it does not define any resources itself, it
# just instantiates infra/terraform/modules/selfhost-ec2, which does the
# real work (EC2 instance, durable EBS data volume, security group, Elastic
# IP, optional Route53 records, and a configurable-schedule snapshot policy),
# then hands off to the exact same `kortix self-host init` / `start` any
# self-host user runs by hand — see ../README.md and
# docs/runbooks/self-hosting.md in the main repo for the full picture.
#
#   cd kortix-selfhost/terraform
#   cp terraform.tfvars.example terraform.tfvars   # fill in your values
#   terraform init
#   terraform apply
#
# Secrets (sandbox provider key, GitHub App, LLM key, ...) are NOT Terraform
# inputs — see the post_apply_next_steps output after apply, and finish setup
# in the dashboard (Settings -> Git, Settings -> Sandbox).
#
# NOTE for when kortix-selfhost/ becomes its own standalone repo: flip
# `source` below from the relative path to this repo's own git URL, e.g.
#   source = "github.com/kortix-ai/kortix-selfhost//terraform/modules/selfhost-ec2?ref=vX.Y.Z"
# (or wherever the module ends up living in that repo) — today it stays a
# relative path so this folder shares one copy of the module with the rest of
# the monorepo instead of duplicating it.

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

module "kortix_selfhost" {
  # Relative source into the monorepo module — see the NOTE above for the
  # standalone-repo path.
  source = "../../infra/terraform/modules/selfhost-ec2"

  domain      = var.domain
  zone_id     = var.route53_zone_id
  api_domain  = var.api_domain
  admin_email = var.admin_email

  name = var.name
  tags = var.tags

  instance_type       = var.instance_type
  ami_id              = var.ami_id
  root_volume_size_gb = var.root_volume_size_gb
  key_name            = var.key_name

  vpc_id            = var.vpc_id
  subnet_id         = var.subnet_id
  allowed_cidrs     = var.allowed_cidrs
  ssh_ingress_cidrs = var.ssh_ingress_cidrs

  data_volume_size_gb    = var.data_volume_size_gb
  data_volume_kms_key_id = var.data_volume_kms_key_id

  backup_interval_hours  = var.backup_interval_hours
  backup_retention_count = var.backup_retention_count
  snapshot_time          = var.snapshot_time

  dns_ttl = var.dns_ttl

  instance_name          = var.instance_name
  kortix_channel         = var.kortix_channel
  kortix_version         = var.kortix_version
  kortix_cli_install_url = var.kortix_cli_install_url
  kortix_cli_channel     = var.kortix_cli_channel
  auto_update            = var.auto_update
  single_account_mode    = var.single_account_mode
  acme_email             = var.acme_email
}

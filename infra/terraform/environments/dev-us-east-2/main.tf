# ── dev-us-east-2 — dev's API/gateway, colocated with the dev database ────────
#
# Problem this root fixes: dev's API ran in us-west-2 while dev's Supabase
# Postgres runs in us-east-2. Every request makes 7-13 SEQUENTIAL database
# round trips (verified via Server-Timing), so the cross-continent hop is
# paid 7-13 times per request: /accounts/me measured 2084ms on dev vs 24ms on
# prod (colocated), for identical code and identical query counts.
#
#   dev-api-use2.kortix.com     → Cloudflare (proxied, Full strict) → ALB → API
#   gateway-dev-use2.kortix.com → Cloudflare (proxied, Full strict) → ALB → gateway
#
# These are this stack's origin hostnames. The dev-api Worker
# (infra/cloudflare/workers/api-router) picks the live origin: ../dev while its
# ACTIVE_BACKEND is "ecs-fargate", this root once it is "us-east-2". The
# switch and its undo are one Worker variable; no DNS record moves. Until the
# switch, this API runs with KORTIX_WORKERS_ENABLED=false in its copy of
# kortix-dev-env, so it never takes the background-worker lease from ../dev.
# README.md in this directory has the apply and switch-over steps.
#
# Naming: local.name is "kortix-dev-use2", NOT "kortix-dev". IAM roles and
# policies are ACCOUNT-GLOBAL, not region-scoped (unlike almost everything
# else an AWS region touches) — reusing "kortix-dev" while ../dev's
# us-west-2 stack (which already owns IAM roles of that name) is still live
# would collide on `terraform apply` the moment this root tried to create
# them. The project-snapshots S3 bucket name is globally unique for the same
# reason: "kortix-dev-project-snapshots" already exists in us-west-2 and
# cannot be reused until that bucket is deleted. Keeping distinct names lets
# both regions run in parallel — "stand the new region up before tearing the
# old one down" — with zero risk of the two roots fighting over one resource.

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
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : (var.cloudflare_api_key != "" ? null : "0000000000000000000000000000000000000000")
  email     = var.cloudflare_api_key != "" ? var.cloudflare_email : null
  api_key   = var.cloudflare_api_key != "" ? var.cloudflare_api_key : null
}

locals {
  name = "kortix-dev-use2"
  cloudflare_ip_ranges = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
  tags = {
    Environment = "dev"
    Region      = "us-east-2"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

# ── Network (VPC + public/private subnets + NAT) ──────────────────────────────
module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr               = "10.14.0.0/16" # distinct from dev (10.10), staging (10.20), staging-euw2 (10.24)
  az_count           = 2
  single_nat_gateway = true # dev: one NAT to save cost, matches ../dev
  tags               = local.tags
}

# ── TLS cert (ACM, DNS-validated via Cloudflare) ───────────────────────────────
# A *.kortix.com wildcard cert already exists in us-east-2 (created by
# ../prod-us-east-2-shadow's module.certificate) and its validation CNAME is
# already in the zone, so a second request for the identical domain in this
# same region+account validates against that existing record without this
# root creating a new one (manage_validation_records = false — same reason
# ../prod-us-east-2-shadow/main.tf sets it). Covers both the primary API
# hostname and the gateway hostname with one cert, so no separate
# gateway_certificate_arn plumbing is needed the way ../dev needs it.
module "certificate" {
  count                     = var.enable_https ? 1 : 0
  source                    = "../../modules/acm-cloudflare"
  domain_name               = "*.kortix.com"
  subject_alternative_names = ["kortix.com"]
  manage_validation_records = false
  zone_id                   = var.cloudflare_zone_id
  tags                      = merge(local.tags, { Service = "certificate" })
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

# ── ECS Fargate API service (autoscaled) ──────────────────────────────────────
data "aws_secretsmanager_secret" "env" {
  name = "kortix-dev-env"
}

# ── Project snapshot object store (S3 config provider) ────────────────────────
# New bucket, new region: "kortix-dev-project-snapshots" (us-west-2) already
# exists and S3 bucket names are globally unique, so this cannot reuse that
# name. Snapshots are DERIVED data (rebuilt from Git on a cache miss), so a
# fresh, empty bucket here is safe by construction — nothing to migrate.
module "project_snapshots" {
  source                = "../../modules/project-snapshots-bucket"
  name                  = "${local.name}-project-snapshots"
  tags                  = local.tags
  transfer_acceleration = true # same rationale as ../dev: sandboxes are not colocated with this bucket either
}

# ── Audit-event archive (WORM) ────────────────────────────────────────────────
# Weekly kortix.audit_events partitions older than the 90-day hot window,
# exported by the API as gzip JSONL with Object Lock retention (365 days). The
# task names it through AUDIT_ARCHIVE_BUCKET / AUDIT_ARCHIVE_REGION in the
# deploy workflow. Applying this creates the bucket, its KMS key, and the
# task-role grant only.
module "audit_archive" {
  source = "../../modules/audit-archive-bucket"
  name   = "${local.name}-audit-archive"
  # Disposable environment: GOVERNANCE lets an operator with s3:BypassGovernanceRetention
  # clear test data. Prod uses COMPLIANCE (the module default).
  object_lock_mode = "GOVERNANCE"
  tags             = local.tags
}

module "api" {
  source     = "../../modules/ecs-api"
  name       = local.name
  aws_region = var.aws_region

  vpc_id = module.network.vpc_id
  public_subnet_ids = [
    module.network.public_subnet_ids[0],
    module.network.public_subnet_ids[1],
  ]
  private_subnet_ids = module.network.private_subnet_ids

  image           = var.api_image
  container_port  = var.container_port
  certificate_arn = one(module.certificate[*].certificate_arn)
  environment = merge(var.api_environment, {
    LLM_GATEWAY_PROXY_TARGET = "https://gateway-dev-use2.kortix.com"
  })
  secrets                     = var.api_secrets
  secrets_blob_arn            = data.aws_secretsmanager_secret.env.arn
  ses_send_region             = "us-east-2"
  ses_send_identity_names     = ["kortix.com", "kortix.ai"]
  project_snapshots_enabled   = true
  project_snapshot_bucket_arn = module.project_snapshots.bucket_arn
  audit_archive_enabled       = true
  audit_archive_bucket_arn    = module.audit_archive.bucket_arn
  audit_archive_kms_key_arn   = module.audit_archive.kms_key_arn

  alb_ingress_cidrs = local.cloudflare_ip_ranges

  # Same sizing as ../dev (see that file's comment history for the
  # OOM-driven task_memory floor). Identical instance class, different region.
  task_cpu                   = 1024
  task_memory                = 4096
  desired_count              = 2
  min_capacity               = 2
  max_capacity               = 6
  use_fargate_spot           = true
  requests_per_target_target = 600
  tags                       = local.tags
}

# ── Gateway (LLM proxy) as its own ECS Fargate service ────────────────────────
module "gateway" {
  source     = "../../modules/ecs-api"
  name       = "${local.name}-gateway"
  aws_region = var.aws_region

  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  image             = var.gateway_image
  container_name    = "gateway"
  container_port    = 8090
  health_check_path = "/health/live"
  certificate_arn   = one(module.certificate[*].certificate_arn)
  environment       = merge(var.gateway_environment, { KORTIX_API_URL = "https://dev-api.kortix.com" })
  secrets           = var.api_secrets
  secrets_blob_arn  = data.aws_secretsmanager_secret.env.arn

  alb_ingress_cidrs = local.cloudflare_ip_ranges

  task_cpu                   = 512
  task_memory                = 2048
  desired_count              = 2
  min_capacity               = 2
  max_capacity               = 8
  use_fargate_spot           = true
  deregistration_delay       = 300
  stop_timeout               = 120
  requests_per_target_target = 120
  tags                       = local.tags
}

# ── DNS: this stack's origin hostnames ────────────────────────────────────────
# dev-api-use2 / gateway-dev-use2 → this root's ALBs. The dev-api Worker decides
# which origin serves dev-api.kortix.com, so these records never change at the
# switch-over.
module "dns" {
  source  = "../../modules/cloudflare-dns"
  count   = var.manage_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id

  records = {
    dev-api-use2 = {
      name    = "dev-api-use2"
      type    = "CNAME"
      value   = module.api.alb_dns_name
      proxied = true
      ttl     = 1
    }
    gateway-dev-use2 = {
      name    = "gateway-dev-use2"
      type    = "CNAME"
      value   = module.gateway.alb_dns_name
      proxied = true
      ttl     = 1
    }
  }
}

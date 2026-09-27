# ── staging-eu-west-2 — staging's API/gateway, colocated with the staging DB ──
#
# Same problem class as ../dev-us-east-2 (see that root's main.tf header):
# staging's API ran in us-west-2 while staging's Supabase Postgres runs in
# eu-west-2. Moving here also makes staging match PROD's topology (prod is
# already eu-west-2 API / eu-west-2 DB) — staging becomes a truer release
# candidate for prod's latency profile, not just a colocation fix.
#
#   staging-api-euw2-shadow.kortix.com    → Cloudflare (proxied) → ALB
#   gateway-staging-euw2-shadow.kortix.com → Cloudflare (proxied) → ALB
#
# Shadow verification hostnames only — ../staging keeps serving
# staging-api-ecs-fargate.kortix.com / gateway-staging-ecs-fargate.kortix.com
# until the runbook's cutover step. See
# docs/runbooks/region-colocation-dev-staging.md.
#
# Naming: local.name is "kortix-staging-euw2", not "kortix-staging" — IAM
# roles/policies are account-global and the project-snapshots S3 bucket name
# is globally unique, so this root cannot reuse ../staging's names while both
# are live. Same reasoning as ../dev-us-east-2.
#
# Unlike ../dev-us-east-2, eu-west-2 has NO existing *.kortix.com wildcard
# cert to piggyback on (prod's own main.tf says so verbatim: "eu-west-2 has
# no *.kortix.com wildcard"), so this root creates two dedicated per-domain
# certs (api + gateway), exactly like ../prod does.

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
  name           = "kortix-staging-euw2"
  api_domain     = "staging-api-euw2-shadow.kortix.com"
  gateway_domain = "gateway-staging-euw2-shadow.kortix.com"
  cloudflare_ip_ranges = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
  tags = {
    Environment = "staging"
    Region      = "eu-west-2"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

# ── Network (VPC + public/private subnets + NAT) ──────────────────────────────
module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr               = "10.24.0.0/16" # distinct from staging (10.20), dev-use2 (10.14), prod (10.20 eu-west-2 — different region, no collision)
  az_count           = 2
  single_nat_gateway = true # staging: one NAT to save cost, matches ../staging
  tags               = local.tags
}

data "aws_secretsmanager_secret" "env" {
  name = "kortix-staging-env"
}

# ── Project snapshot object store (S3 config provider) ────────────────────────
# New bucket, new region — "kortix-staging-project-snapshots" (us-west-2)
# already exists and S3 bucket names are globally unique. Snapshots are
# derived data, so a fresh empty bucket is safe.
module "project_snapshots" {
  source = "../../modules/project-snapshots-bucket"
  name   = "${local.name}-project-snapshots"
  tags   = local.tags
}

# ── TLS certs (ACM, DNS-validated via Cloudflare) — one per origin hostname ───
module "acm_api" {
  source      = "../../modules/acm-cloudflare"
  count       = var.enable_https ? 1 : 0
  domain_name = local.api_domain
  zone_id     = var.cloudflare_zone_id
  tags        = local.tags
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

module "acm_gateway" {
  source      = "../../modules/acm-cloudflare"
  count       = var.enable_https ? 1 : 0
  domain_name = local.gateway_domain
  zone_id     = var.cloudflare_zone_id
  tags        = local.tags
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
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
  certificate_arn = one(module.acm_api[*].certificate_arn)
  environment = merge(var.api_environment, {
    LLM_GATEWAY_PROXY_TARGET = "https://${local.gateway_domain}"
  })
  secrets                     = var.api_secrets
  secrets_blob_arn            = data.aws_secretsmanager_secret.env.arn
  ses_send_region             = "us-east-2"
  ses_send_identity_names     = ["kortix.com", "kortix.ai"]
  project_snapshots_enabled   = true
  project_snapshot_bucket_arn = module.project_snapshots.bucket_arn

  alb_ingress_cidrs = local.cloudflare_ip_ranges

  # Same sizing as ../staging today (see that file's comment history —
  # the release gate's own concurrent load drove these numbers). Identical
  # instance class, different region.
  task_cpu                   = 2048
  task_memory                = 4096
  desired_count              = 6
  min_capacity               = 6
  max_capacity               = 8
  use_fargate_spot           = true
  fargate_base_on_demand     = 1
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
  certificate_arn   = one(module.acm_gateway[*].certificate_arn)
  environment       = merge(var.gateway_environment, { KORTIX_API_URL = "https://${local.api_domain}" })
  secrets           = var.api_secrets
  secrets_blob_arn  = data.aws_secretsmanager_secret.env.arn

  alb_ingress_cidrs = local.cloudflare_ip_ranges

  task_cpu                   = 1024
  task_memory                = 2048
  desired_count              = 2
  min_capacity               = 2
  max_capacity               = 8
  use_fargate_spot           = true
  fargate_base_on_demand     = 1
  deregistration_delay       = 300
  stop_timeout               = 120
  requests_per_target_target = 120
  tags                       = local.tags
}

# ── DNS: shadow verification hostnames only ────────────────────────────────────
module "dns" {
  source  = "../../modules/cloudflare-dns"
  count   = var.manage_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id

  records = {
    staging-api-euw2-shadow = {
      name    = "staging-api-euw2-shadow"
      type    = "CNAME"
      value   = module.api.alb_dns_name
      proxied = true
      ttl     = 1
    }
    gateway-staging-euw2-shadow = {
      name    = "gateway-staging-euw2-shadow"
      type    = "CNAME"
      value   = module.gateway.alb_dns_name
      proxied = true
      ttl     = 1
    }
  }
}

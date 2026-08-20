# ── staging environment — ECS Fargate (api + gateway), autoscaled ─────────────
#
#   staging-api-ecs-fargate.kortix.com  → Cloudflare (proxied, Full strict) → ALB
#   gateway-staging-ecs-fargate.kortix.com → Cloudflare → ALB → gateway service
#
# These are the ECS backends the `api-router` Worker (env=staging) routes to via
# its ACTIVE_BACKEND / GATEWAY_ACTIVE_BACKEND toggles; staging-api.kortix.com and
# gateway-staging.kortix.com are the Worker's route/custom-domain hostnames and
# are NOT managed here. Same module set as dev/prod.
#
# To avoid a Cloudflare dependency at apply time, this env uses the *.kortix.com
# wildcard ACM cert directly (no per-host module.acm) and leaves DNS records to be
# created out-of-band (manage_dns=false); the wildcard already passes CF Full(strict).

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
  # Only used if manage_dns=true; a format-valid dummy token lets pure-AWS applies
  # run with no Cloudflare creds.
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : (var.cloudflare_api_key != "" ? null : "0000000000000000000000000000000000000000")
  email     = var.cloudflare_api_key != "" ? var.cloudflare_email : null
  api_key   = var.cloudflare_api_key != "" ? var.cloudflare_api_key : null
}

locals {
  name = "kortix-staging"
  cloudflare_ip_ranges = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
  tags = {
    Environment = "staging"
    Service     = "kortix-api"
    ManagedBy   = "terraform"
  }
}

# ── Network (VPC + public/private subnets + NAT) ──────────────────────────────
module "network" {
  source             = "../../modules/network"
  name               = local.name
  cidr               = "10.20.0.0/16" # distinct from dev (10.10) / prod
  az_count           = 2
  single_nat_gateway = true # staging: one NAT to save cost
  tags               = local.tags
}

# ── ECS Fargate API service (autoscaled) ──────────────────────────────────────
# The env secret blob is the source of truth for which secrets exist:
# ecs-deploy.sh wires every key in it into each task-def revision. Looked up by
# name so the random ARN suffix is never hard-coded.
data "aws_secretsmanager_secret" "env" {
  name = "kortix-staging-env"
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

  image                   = var.api_image
  container_port          = var.container_port
  certificate_arn         = var.wildcard_certificate_arn
  environment             = var.api_environment
  secrets                 = var.api_secrets
  secrets_blob_arn        = data.aws_secretsmanager_secret.env.arn
  ses_send_region         = "us-east-2"
  ses_send_identity_names = ["kortix.com", "kortix.ai"]

  alb_ingress_cidrs = local.cloudflare_ip_ranges

  # staging sizing — see docs/runbooks/staging-sizing.md.
  #
  # Staging must absorb the release gate's FULL concurrent load: `pnpm test --
  # --target-full` drives 441 REST flows plus 21 Playwright journeys against
  # this origin, and it is the only environment that ever sees that traffic.
  # Until 2026-08-19 it ran 1 task of 0.5 vCPU / 1 GiB — SMALLER than dev
  # (2 tasks), which carries no load at all. The v0.13.0 release gate's own
  # traffic drove the single task unhealthy, ECS replaced it mid-run, and the
  # api-router Worker laundered every resulting 5xx into MAINTENANCE_MODE.
  #
  # 2 tasks of 1 vCPU / 2 GiB, floor 2, ceiling 4. fargate_base_on_demand = 1
  # pins the first task to on-demand FARGATE: the rest stay Spot for cost, but
  # a Spot reclaim can no longer take the whole environment to zero.
  # Gate dry-run 32290094936 (2026-08-19, skew-free): with 2 x 1 vCPU tasks a
  # plain POST /v1/accounts took 5.8-6.7s when it succeeded and intermittently
  # 37s -> ALB 5xx -> edge-laundered 503, while the DB sat at 0 slow queries —
  # API event-loop starvation, not data. 3 x 2 vCPU gives the release gate's
  # ~18-worker fleet real JS throughput (~+$150/mo at the floor).
  # 2026-08-20: floor raised 3 -> 6. Dry-run 32323656671 still collapsed the
  # write path at 3 tasks (POST /v1/accounts 2.3-15.2s idle over the eu-west-2
  # DB; 19 workers pushed it past the origin timeout), and a manual
  # ecs-scale to 6 was silently reverted by the next deploy's TF apply —
  # the floor must live here or it does not exist.
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
  certificate_arn   = var.wildcard_certificate_arn
  environment       = merge(var.gateway_environment, { KORTIX_API_URL = "https://staging-api.kortix.com" })
  secrets           = var.api_secrets
  secrets_blob_arn  = data.aws_secretsmanager_secret.env.arn

  alb_ingress_cidrs = local.cloudflare_ip_ranges

  # The gateway proxies every LLM call the release gate's sessions make, so it
  # sees the same burst as the API. requests_per_target_target creates the
  # ALBRequestCountPerTarget policy, which the module skips while the value is
  # 0 (its default) — the gateway had CPU/memory tracking only, and an
  # I/O-bound gateway blocked on upstream models never moves either metric.
  task_cpu                   = 512
  task_memory                = 1024
  desired_count              = 2
  min_capacity               = 2
  max_capacity               = 3
  use_fargate_spot           = true
  fargate_base_on_demand     = 1
  requests_per_target_target = 600
  tags                       = local.tags
}

# ── DNS (optional; default off — records created out-of-band) ─────────────────
module "dns" {
  source  = "../../modules/cloudflare-dns"
  count   = var.manage_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id

  records = {
    staging-api-ecs-fargate = {
      name    = "staging-api-ecs-fargate"
      type    = "CNAME"
      value   = module.api.alb_dns_name
      proxied = true
      ttl     = 1
    }
    gateway-staging-ecs-fargate = {
      name    = "gateway-staging-ecs-fargate"
      type    = "CNAME"
      value   = module.gateway.alb_dns_name
      proxied = true
      ttl     = 1
    }
  }
}

# ── prod-eks (cluster layer) — api-eks.kortix.com on EKS ──────────────────────
#
#   api-eks.kortix.com → Cloudflare (proxied, Full strict) → ALB → EKS pods
#   (managed node group, 3 AZs) in private subnets, egress via per-AZ NAT.
#
# This layer is AWS-only (no kubernetes/helm providers), so it plans/applies
# against a cluster that does not exist yet. It builds:
#   - an isolated VPC (own /16, 3 AZ, NAT per AZ) — does NOT touch the ECS VPC,
#   - the EKS control plane + managed node group (modules/eks/cluster),
#   - the ACM cert for api-eks.kortix.com (validated via Cloudflare DNS),
#   - the app's IRSA role (reads the SAME Secrets Manager bundle ECS uses),
#   - the GitHub Actions OIDC deploy role + its EKS access entry.
#
# The in-cluster controllers + the app live in the sibling `platform` layer and
# the Helm chart, applied AFTER this. ECS prod is entirely untouched; this runs
# in parallel under a different hostname until api.kortix.com is flipped to it.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.79"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 4.0, < 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "cloudflare" {
  # Same auth precedence as the ECS envs: scoped token → global key → dummy
  # (so a plan with no CF creds doesn't reject an empty token).
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : (var.cloudflare_api_key != "" ? null : "0000000000000000000000000000000000000000")
  email     = var.cloudflare_api_key != "" ? var.cloudflare_email : null
  api_key   = var.cloudflare_api_key != "" ? var.cloudflare_api_key : null
}

locals {
  name   = "kortix-prod-eks"
  domain = var.api_domain
  tags = {
    Environment = "prod"
    Service     = "kortix-api"
    Platform    = "eks"
    ManagedBy   = "terraform"
  }
}

# ── Network (own VPC; EKS subnet-discovery tags via the shared module) ─────────
module "network" {
  source             = "../../../modules/network"
  name               = local.name
  cidr               = var.vpc_cidr
  az_count           = 3
  single_nat_gateway = false # prod: NAT per AZ (HA egress)
  tags               = local.tags

  extra_vpc_tags = { "kubernetes.io/cluster/${local.name}" = "shared" }
  extra_public_subnet_tags = {
    "kubernetes.io/role/elb"              = "1"
    "kubernetes.io/cluster/${local.name}" = "shared"
  }
  extra_private_subnet_tags = {
    "kubernetes.io/role/internal-elb"     = "1"
    "kubernetes.io/cluster/${local.name}" = "shared"
  }
}

# ── EKS control plane + managed node group ────────────────────────────────────
module "eks" {
  source          = "../../../modules/eks/cluster"
  name            = local.name
  cluster_version = var.cluster_version

  control_plane_subnet_ids = concat(module.network.public_subnet_ids, module.network.private_subnet_ids)
  node_subnet_ids          = module.network.private_subnet_ids

  endpoint_public_access       = true
  endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs

  node_instance_types = var.node_instance_types
  node_desired_size   = var.node_desired_size
  node_min_size       = var.node_min_size
  node_max_size       = var.node_max_size

  tags = local.tags
}

# ── TLS cert for api-eks.kortix.com (ACM, validated via Cloudflare DNS) ────────
module "acm" {
  source      = "../../../modules/acm-cloudflare"
  domain_name = local.domain
  zone_id     = var.cloudflare_zone_id
  tags        = local.tags
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

# ── TLS cert for the Argo CD UI (ops.kortix.com) ──────────────────────────────
# The Argo CD admin UI is exposed via its own ALB (configured in the platform
# layer). It is an admin control plane, so the public path MUST be gated by
# Cloudflare Access + a Cloudflare-IP-locked ALB — see infra/GITOPS.md.
module "acm_argocd" {
  source      = "../../../modules/acm-cloudflare"
  domain_name = var.argocd_domain
  zone_id     = var.cloudflare_zone_id
  tags        = local.tags
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

# ── App IRSA role: read the SAME Secrets Manager bundle ECS uses ───────────────
# The app's ServiceAccount (kube ns/SA below) assumes this to let External
# Secrets pull `var.app_secret_name` into the cluster. Scoped to that one secret.
data "aws_secretsmanager_secret" "app_env" {
  name = var.app_secret_name
}

data "aws_iam_policy_document" "app_secrets_read" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [data.aws_secretsmanager_secret.app_env.arn]
  }
}

module "app_irsa" {
  source            = "../../../modules/eks/irsa"
  name              = "${local.name}-app"
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  namespace         = var.app_namespace
  service_accounts  = [var.app_service_account]
  policy_json       = data.aws_iam_policy_document.app_secrets_read.json
  tags              = local.tags
}

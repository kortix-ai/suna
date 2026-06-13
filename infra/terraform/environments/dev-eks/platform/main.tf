# ── dev-eks (platform layer) — in-cluster controllers + app namespace ─────────
#
# Applied AFTER the dev `cluster` layer. Reads that layer's outputs from remote
# state to configure the kubernetes/helm providers against the LIVE API server,
# then installs the platform controllers (modules/eks/platform) and creates the
# app namespace the CI Helm deploy targets.
#
# Mirrors prod-eks/platform, but the Argo CD UI + GitHub SSO default OFF for dev
# (headless; access via `kubectl -n argocd port-forward`). Flip them on in
# terraform.tfvars if you want a dev Argo UI later.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.12, < 3.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.27, < 3.0"
    }
  }
}

data "terraform_remote_state" "cluster" {
  backend = "s3"
  config = {
    bucket         = "kortix-terraform-state"
    key            = "dev-eks/cluster.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
  }
}

locals {
  cluster = data.terraform_remote_state.cluster.outputs
}

provider "aws" {
  region = local.cluster.aws_region
}

# Both providers authenticate to the cluster with a short-lived token minted by
# the AWS CLI (`aws eks get-token`) — no kubeconfig on disk, no static creds.
provider "kubernetes" {
  host                   = local.cluster.cluster_endpoint
  cluster_ca_certificate = base64decode(local.cluster.cluster_ca_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", local.cluster.cluster_name, "--region", local.cluster.aws_region]
  }
}

provider "helm" {
  kubernetes {
    host                   = local.cluster.cluster_endpoint
    cluster_ca_certificate = base64decode(local.cluster.cluster_ca_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", local.cluster.cluster_name, "--region", local.cluster.aws_region]
    }
  }
}

# The app namespace. Pre-created here (not via `helm --create-namespace`) so the
# CI deploy role — which has write access ONLY inside this namespace — never
# needs cluster-scoped permission to create it.
resource "kubernetes_namespace" "app" {
  metadata {
    name = local.cluster.app_namespace
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

module "platform" {
  source            = "../../../modules/eks/platform"
  cluster_name      = local.cluster.cluster_name
  aws_region        = local.cluster.aws_region
  vpc_id            = local.cluster.vpc_id
  oidc_provider_arn = local.cluster.oidc_provider_arn
  oidc_provider_url = local.cluster.oidc_provider_url
  api_domain        = local.cluster.api_domain

  cloudflare_api_token = var.cloudflare_api_token

  # Argo CD UI (dev-ops.kortix.com) — OFF by default for dev (headless).
  argocd_ui_enabled      = var.argocd_ui_enabled
  argocd_domain          = local.cluster.argocd_domain
  argocd_certificate_arn = local.cluster.acm_argocd_certificate_arn

  # GitHub-org SSO for Argo CD login — OFF by default for dev.
  argocd_github_sso_enabled   = var.argocd_github_sso_enabled
  argocd_github_org           = var.argocd_github_org
  argocd_admin_team           = var.argocd_admin_team
  argocd_github_client_id     = var.argocd_github_client_id
  argocd_github_client_secret = var.argocd_github_client_secret
  argocd_disable_admin        = var.argocd_disable_admin

  tags = {
    Environment = "dev"
    Service     = "kortix-api"
    Platform    = "eks"
    ManagedBy   = "terraform"
  }
}

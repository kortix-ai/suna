module "platform" {
  source               = "../eks/platform"
  cluster_name         = var.cluster_name
  aws_region           = var.aws_region
  vpc_id               = var.vpc_id
  oidc_provider_arn    = var.oidc_provider_arn
  oidc_provider_url    = var.oidc_provider_url
  api_domain           = var.api_domain
  extra_domain_filters = [var.frontend_domain]

  external_dns_provider = "aws"
  route53_zone_id       = var.route53_zone_id
  external_dns_role_arn = var.external_dns_role_arn

  # The customer-owned updater is the sole deployment authority for verified
  # enterprise Helm state. Argo CD remains enabled by default for Kortix Cloud,
  # but installing it here would create two reconcilers for the same workloads.
  argo_cd_enabled             = false
  argocd_ui_enabled           = false
  argocd_github_sso_enabled   = false
  argocd_disable_admin        = true
  permissions_boundary_arn    = var.permissions_boundary_arn
  alb_controller_role_arn     = var.alb_controller_role_arn
  cluster_autoscaler_role_arn = var.autoscaler_role_arn
  argo_rollouts_role_arn      = var.argo_rollouts_role_arn

  tags = var.tags
}

resource "kubernetes_namespace" "app" {
  metadata {
    name = var.app_namespace
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      "app.kubernetes.io/part-of"    = "kortix-enterprise"
    }
  }
}

resource "kubernetes_service_account" "app" {
  metadata {
    name      = var.app_service_account
    namespace = kubernetes_namespace.app.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = var.app_irsa_role_arn
    }
  }
}

resource "kubernetes_manifest" "secret_store" {
  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "SecretStore"
    metadata = {
      name      = "kortix-runtime"
      namespace = kubernetes_namespace.app.metadata[0].name
    }
    spec = {
      provider = {
        aws = {
          service = "SecretsManager"
          region  = var.aws_region
          auth = {
            jwt = {
              serviceAccountRef = {
                name = kubernetes_service_account.app.metadata[0].name
              }
            }
          }
        }
      }
    }
  }

  depends_on = [module.platform]
}

resource "kubernetes_manifest" "runtime_secret" {
  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "kortix-runtime"
      namespace = kubernetes_namespace.app.metadata[0].name
    }
    spec = {
      refreshInterval = "5m"
      secretStoreRef = {
        kind = "SecretStore"
        name = "kortix-runtime"
      }
      target = {
        name           = "kortix-runtime"
        creationPolicy = "Owner"
      }
      dataFrom = [{
        extract = { key = var.runtime_secret_arn }
      }]
    }
  }

  depends_on = [kubernetes_manifest.secret_store]
}

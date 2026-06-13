# In-cluster platform controllers, installed via Helm. These turn the bare EKS
# cluster (modules/eks/cluster) into something the app can actually run on with
# production uptime + self-healing:
#
#   aws-load-balancer-controller  Ingress -> a real ALB (with the ACM cert)
#   external-secrets              syncs the Secrets Manager bundle into the cluster
#   external-dns                  api-eks.kortix.com -> the ALB (Cloudflare, proxied)
#   metrics-server               the metrics source HPA scales pods on
#   cluster-autoscaler           grows/shrinks the node group so HPA can place pods
#
# Chart versions are PINNED for reproducibility — bump deliberately. This module
# is applied AFTER the cluster exists (its own Terraform state), so the
# helm/kubernetes providers can reach a live API server.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.12"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.27"
    }
  }
}

# ── AWS Load Balancer Controller ──────────────────────────────────────────────
resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = var.alb_controller_chart_version
  namespace  = "kube-system"
  atomic     = true
  timeout    = 600

  set {
    name  = "clusterName"
    value = var.cluster_name
  }
  set {
    name  = "region"
    value = var.aws_region
  }
  set {
    name  = "vpcId"
    value = var.vpc_id
  }
  set {
    name  = "serviceAccount.create"
    value = "true"
  }
  set {
    name  = "serviceAccount.name"
    value = "aws-load-balancer-controller"
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.alb_controller_irsa.role_arn
  }
  # Run 2 replicas so the controller itself is HA.
  set {
    name  = "replicaCount"
    value = "2"
  }
}

# ── External Secrets Operator ─────────────────────────────────────────────────
resource "helm_release" "external_secrets" {
  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = var.external_secrets_chart_version
  namespace        = "external-secrets"
  create_namespace = true
  atomic           = true
  timeout          = 600

  set {
    name  = "installCRDs"
    value = "true"
  }
  # HA for the webhook + controller.
  set {
    name  = "replicaCount"
    value = "2"
  }
  set {
    name  = "webhook.replicaCount"
    value = "2"
  }
}

# ── external-dns (Cloudflare) ─────────────────────────────────────────────────
# policy=sync + a txtOwnerId registry means external-dns only ever touches
# records IT created (tagged with the TXT owner), and domainFilters confines it
# to api-eks.kortix.com — so it can never disturb api.kortix.com, api-ecs, or any
# other record in the shared zone.
#
# zoneIdFilters pins the kortix.com hosted zone by ID. This is REQUIRED: the
# domainFilters are subdomains (api-eks / preview-api), and external-dns's zone
# discovery only matches a zone whose NAME equals or is a parent of a filter —
# "kortix.com" is neither, so without the zone-id pin external-dns finds no
# hosted zone, logs "no hosted zone matching record DNS Name", and silently
# manages nothing. The domainFilters still scope which records it may write.
resource "helm_release" "external_dns" {
  name       = "external-dns"
  repository = "https://kubernetes-sigs.github.io/external-dns/"
  chart      = "external-dns"
  version    = var.external_dns_chart_version
  namespace  = "kube-system"
  atomic     = true
  timeout    = 600

  values = [yamlencode({
    provider = {
      name = "cloudflare"
    }
    env = [{
      name = "CF_API_TOKEN"
      valueFrom = {
        secretKeyRef = {
          name = kubernetes_secret.cloudflare_api_token.metadata[0].name
          key  = "apiToken"
        }
      }
    }]
    domainFilters = concat([var.api_domain], var.extra_domain_filters)
    zoneIdFilters = var.cloudflare_zone_id != "" ? [var.cloudflare_zone_id] : []
    policy        = "sync"
    registry      = "txt"
    txtOwnerId    = var.cluster_name
    # Cloudflare proxying is decided per-record via the Ingress annotation
    # external-dns.alpha.kubernetes.io/cloudflare-proxied (set in the app chart).
    sources = ["ingress"]
    serviceAccount = {
      create = true
      name   = "external-dns"
    }
  })]
}

# ── metrics-server (HPA metrics source) ───────────────────────────────────────
resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = var.metrics_server_chart_version
  namespace  = "kube-system"
  atomic     = true
  timeout    = 600

  set {
    name  = "replicas"
    value = "2"
  }
  # Spread the 2 replicas so a node loss doesn't blind the HPA.
  set {
    name  = "podDisruptionBudget.enabled"
    value = "true"
  }
  set {
    name  = "podDisruptionBudget.minAvailable"
    value = "1"
  }
}

# ── Cluster Autoscaler ────────────────────────────────────────────────────────
resource "helm_release" "cluster_autoscaler" {
  name       = "cluster-autoscaler"
  repository = "https://kubernetes.github.io/autoscaler"
  chart      = "cluster-autoscaler"
  version    = var.cluster_autoscaler_chart_version
  namespace  = "kube-system"
  atomic     = true
  timeout    = 600

  set {
    name  = "autoDiscovery.clusterName"
    value = var.cluster_name
  }
  set {
    name  = "awsRegion"
    value = var.aws_region
  }
  set {
    name  = "rbac.serviceAccount.create"
    value = "true"
  }
  set {
    name  = "rbac.serviceAccount.name"
    value = "cluster-autoscaler"
  }
  set {
    name  = "rbac.serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.cluster_autoscaler_irsa.role_arn
  }
  # Prefer the cheapest node shape that fits pending pods, and keep AZs balanced.
  set {
    name  = "extraArgs.balance-similar-node-groups"
    value = "true"
  }
  set {
    name  = "extraArgs.expander"
    value = "least-waste"
  }
}

# ── Argo CD values (built up: HA + optional UI ingress + optional GitHub SSO) ──
locals {
  argocd_alb_annotations = {
    "alb.ingress.kubernetes.io/scheme"                    = "internet-facing"
    "alb.ingress.kubernetes.io/target-type"               = "ip"
    "alb.ingress.kubernetes.io/listen-ports"              = "[{\"HTTP\":80},{\"HTTPS\":443}]"
    "alb.ingress.kubernetes.io/ssl-redirect"              = "443"
    "alb.ingress.kubernetes.io/ssl-policy"                = "ELBSecurityPolicy-TLS13-1-2-2021-06"
    "alb.ingress.kubernetes.io/certificate-arn"           = var.argocd_certificate_arn
    "alb.ingress.kubernetes.io/backend-protocol"          = "HTTP"
    "alb.ingress.kubernetes.io/healthcheck-path"          = "/healthz"
    "alb.ingress.kubernetes.io/success-codes"             = "200"
    "alb.ingress.kubernetes.io/inbound-cidrs"             = join(",", var.cloudflare_inbound_cidrs)
    "external-dns.alpha.kubernetes.io/hostname"           = var.argocd_domain
    "external-dns.alpha.kubernetes.io/cloudflare-proxied" = "true"
  }

  # Dex GitHub-org connector: log in with GitHub, restricted to the org. The
  # client secret is referenced from argocd-secret ($dex.github.clientSecret).
  argocd_dex_config = <<-EOT
    connectors:
      - type: github
        id: github
        name: GitHub
        config:
          clientID: ${var.argocd_github_client_id}
          clientSecret: $dex.github.clientSecret
          orgs:
            - name: ${var.argocd_github_org}
  EOT

  argocd_values = {
    "redis-ha"     = { enabled = false }
    applicationSet = { replicas = 2 }
    repoServer     = { replicas = 2 }
    server = merge(
      { replicas = 2 },
      var.argocd_ui_enabled ? {
        ingress = {
          enabled          = true
          ingressClassName = "alb"
          hostname         = var.argocd_domain
          path             = "/"
          pathType         = "Prefix"
          tls              = false
          annotations      = local.argocd_alb_annotations
        }
      } : {}
    )
    configs = {
      # server.insecure: HTTP behind the TLS-terminating ALB (UI mode).
      params = var.argocd_ui_enabled ? { "server.insecure" = true } : {}
      cm = merge(
        var.argocd_ui_enabled ? { url = "https://${var.argocd_domain}" } : {},
        var.argocd_github_sso_enabled ? {
          "dex.config"    = local.argocd_dex_config
          "admin.enabled" = tostring(!var.argocd_disable_admin)
        } : {}
      )
      # Org members get read-only; the admin team gets full admin. Dex returns
      # GitHub groups as "org:team" in the groups claim (Argo's default scope),
      # so the admin team maps via "org:team". Tighten/expand later.
      rbac = var.argocd_github_sso_enabled ? {
        "policy.default" = "role:readonly"
        "policy.csv"     = "g, ${var.argocd_github_org}:${var.argocd_admin_team}, role:admin\n"
      } : {}
      secret = var.argocd_github_sso_enabled ? {
        extra = { "dex.github.clientSecret" = var.argocd_github_client_secret }
      } : {}
    }
  }
}

# ── Argo CD (GitOps deploy engine) ────────────────────────────────────────────
# The single deploy engine: it reconciles the cluster to the manifests in
# infra/k8s/ (app-of-apps), replacing imperative `helm upgrade`/`aws ecs` calls.
# UI at ops.kortix.com (Cloudflare-Access gated) when argocd_ui_enabled; GitHub-
# org SSO + admin retirement when argocd_github_sso_enabled.
resource "helm_release" "argo_cd" {
  name             = "argo-cd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.argo_cd_chart_version
  namespace        = "argocd"
  create_namespace = true
  atomic           = true
  timeout          = 900

  values = [yamlencode(local.argocd_values)]
}

# ── Argo Rollouts (progressive delivery) ──────────────────────────────────────
# Controller for canary Rollouts + AnalysisRuns. The Rollout resources + the
# CloudWatch AnalysisTemplate are added in Phase 2 (chart + argocd/analysis);
# this just installs the controller + CRDs.
resource "helm_release" "argo_rollouts" {
  name             = "argo-rollouts"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-rollouts"
  version          = var.argo_rollouts_chart_version
  namespace        = "argo-rollouts"
  create_namespace = true
  atomic           = true
  timeout          = 600

  set {
    name  = "controller.replicas"
    value = "2"
  }
  # IRSA so the controller can query CloudWatch for canary analysis.
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.argo_rollouts_irsa.role_arn
  }
}

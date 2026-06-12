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
    domainFilters = [var.api_domain]
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

# ── Argo CD (GitOps deploy engine) ────────────────────────────────────────────
# The single deploy engine: it reconciles the cluster to the manifests in
# infra/k8s/ (app-of-apps), replacing imperative `helm upgrade`/`aws ecs` calls.
# Installed once here; thereafter it self-manages via the app-of-apps. Server is
# ClusterIP (reach it with `kubectl -n argocd port-forward svc/argocd-server`).
resource "helm_release" "argo_cd" {
  name             = "argo-cd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.argo_cd_chart_version
  namespace        = "argocd"
  create_namespace = true
  atomic           = true
  timeout          = 900

  # Run the core controllers with 2 replicas where the chart supports it (HA-lite).
  set {
    name  = "redis-ha.enabled"
    value = "false"
  }
  set {
    name  = "applicationSet.replicas"
    value = "2"
  }
  set {
    name  = "server.replicas"
    value = "2"
  }
  set {
    name  = "repoServer.replicas"
    value = "2"
  }
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

# ── IRSA roles for the controllers that call AWS APIs ─────────────────────────
# External Secrets and external-dns do NOT get AWS IRSA here:
#   - external-dns talks to Cloudflare (an API token, not AWS) — see the secret
#     below.
#   - External Secrets reads Secrets Manager by assuming the APP's IRSA role via
#     the SecretStore's serviceAccountRef (scoped to the one bundle), so the ESO
#     controller itself needs no standing AWS permissions. The app role lives in
#     environments/prod-eks/cluster.

# AWS Load Balancer Controller — provisions/owns the ALB from the app's Ingress.
module "alb_controller_irsa" {
  source            = "../irsa"
  name              = "${var.cluster_name}-alb-controller"
  oidc_provider_arn = var.oidc_provider_arn
  oidc_provider_url = var.oidc_provider_url
  namespace         = "kube-system"
  service_accounts  = ["aws-load-balancer-controller"]
  policy_json       = file("${path.module}/files/alb-controller-policy.json")
  tags              = var.tags
}

# Cluster Autoscaler — scales the managed node group so HPA always has somewhere
# to place pods. Write actions are scoped to THIS cluster's ASG via the
# auto-applied k8s.io/cluster-autoscaler/<name> tag.
data "aws_iam_policy_document" "cluster_autoscaler" {
  statement {
    sid    = "Discovery"
    effect = "Allow"
    actions = [
      "autoscaling:DescribeAutoScalingGroups",
      "autoscaling:DescribeAutoScalingInstances",
      "autoscaling:DescribeLaunchConfigurations",
      "autoscaling:DescribeScalingActivities",
      "autoscaling:DescribeTags",
      "ec2:DescribeImages",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeLaunchTemplateVersions",
      "ec2:GetInstanceTypesFromInstanceRequirements",
      "eks:DescribeNodegroup",
    ]
    resources = ["*"]
  }
  statement {
    sid    = "ScaleThisCluster"
    effect = "Allow"
    actions = [
      "autoscaling:SetDesiredCapacity",
      "autoscaling:TerminateInstanceInAutoScalingGroup",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/k8s.io/cluster-autoscaler/${var.cluster_name}"
      values   = ["owned"]
    }
  }
}

module "cluster_autoscaler_irsa" {
  source            = "../irsa"
  name              = "${var.cluster_name}-cluster-autoscaler"
  oidc_provider_arn = var.oidc_provider_arn
  oidc_provider_url = var.oidc_provider_url
  namespace         = "kube-system"
  service_accounts  = ["cluster-autoscaler"]
  policy_json       = data.aws_iam_policy_document.cluster_autoscaler.json
  tags              = var.tags
}

# Argo Rollouts controller — reads CloudWatch so the canary AnalysisRuns can
# query ALB error-rate + latency to auto-promote / auto-rollback.
data "aws_iam_policy_document" "rollouts_cloudwatch" {
  statement {
    effect    = "Allow"
    actions   = ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics"]
    resources = ["*"]
  }
}

module "argo_rollouts_irsa" {
  source            = "../irsa"
  name              = "${var.cluster_name}-argo-rollouts"
  oidc_provider_arn = var.oidc_provider_arn
  oidc_provider_url = var.oidc_provider_url
  namespace         = "argo-rollouts"
  service_accounts  = ["argo-rollouts"]
  policy_json       = data.aws_iam_policy_document.rollouts_cloudwatch.json
  tags              = var.tags
}

# ── Cloudflare API token for external-dns ─────────────────────────────────────
# external-dns reads CF_API_TOKEN from this secret to create the proxied
# api-eks.kortix.com record pointing at the ALB it discovers.
resource "kubernetes_secret" "cloudflare_api_token" {
  metadata {
    name      = "cloudflare-api-token"
    namespace = "kube-system"
  }
  data = {
    apiToken = var.cloudflare_api_token
  }
  type = "Opaque"
}

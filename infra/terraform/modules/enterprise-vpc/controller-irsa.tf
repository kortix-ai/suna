# Controller trust belongs to the customer-reviewed cluster/bootstrap stage.
# The automatic stable updater may install or update Kubernetes controllers,
# but it cannot create or mutate their IAM trust or permissions.
module "alb_controller_irsa" {
  source            = "../eks/irsa"
  name              = "${var.name}-alb-controller"
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url
  namespace         = "kube-system"
  service_accounts  = ["aws-load-balancer-controller"]
  policy_json       = file("${path.module}/../eks/platform/files/alb-controller-policy.json")
  tags              = local.tags
}

data "aws_iam_policy_document" "cluster_autoscaler" {
  #checkov:skip=CKV_AWS_356:AWS autoscaling discovery requires Resource star; scaling writes require this cluster's ownership tag.
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
      variable = "aws:ResourceTag/k8s.io/cluster-autoscaler/${var.name}"
      values   = ["owned"]
    }
  }
}

module "cluster_autoscaler_irsa" {
  source                   = "../eks/irsa"
  name                     = "${var.name}-cluster-autoscaler"
  oidc_provider_arn        = module.eks.oidc_provider_arn
  oidc_provider_url        = module.eks.oidc_provider_url
  namespace                = "kube-system"
  service_accounts         = ["cluster-autoscaler"]
  policy_json              = data.aws_iam_policy_document.cluster_autoscaler.json
  permissions_boundary_arn = var.permissions_boundary_arn
  tags                     = local.tags
}

data "aws_iam_policy_document" "rollouts_cloudwatch" {
  #checkov:skip=CKV_AWS_356:CloudWatch read APIs used for canary analysis do not support resource-level scoping.
  statement {
    sid       = "ReadCanaryMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics"]
    resources = ["*"]
  }
}

module "argo_rollouts_irsa" {
  source                   = "../eks/irsa"
  name                     = "${var.name}-argo-rollouts"
  oidc_provider_arn        = module.eks.oidc_provider_arn
  oidc_provider_url        = module.eks.oidc_provider_url
  namespace                = "argo-rollouts"
  service_accounts         = ["argo-rollouts"]
  policy_json              = data.aws_iam_policy_document.rollouts_cloudwatch.json
  permissions_boundary_arn = var.permissions_boundary_arn
  tags                     = local.tags
}

data "aws_iam_policy_document" "external_dns" {
  statement {
    sid    = "ChangeOnlyCustomerZone"
    effect = "Allow"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
    ]
    resources = ["arn:${local.partition}:route53:::hostedzone/${var.route53_zone_id}"]
  }

  # Route 53 discovery APIs do not support resource-level permissions. The
  # external-dns deployment is additionally pinned to route53_zone_id.
  #checkov:skip=CKV_AWS_356:Route 53 hosted-zone discovery APIs require Resource star.
  statement {
    sid    = "DiscoverCustomerZone"
    effect = "Allow"
    actions = [
      "route53:ListHostedZones",
      "route53:ListHostedZonesByName",
      "route53:ListTagsForResource",
    ]
    resources = ["*"]
  }
}

module "external_dns_irsa" {
  source                   = "../eks/irsa"
  name                     = "${var.name}-external-dns"
  oidc_provider_arn        = module.eks.oidc_provider_arn
  oidc_provider_url        = module.eks.oidc_provider_url
  namespace                = "kube-system"
  service_accounts         = ["external-dns"]
  policy_json              = data.aws_iam_policy_document.external_dns.json
  permissions_boundary_arn = var.permissions_boundary_arn
  tags                     = local.tags
}
